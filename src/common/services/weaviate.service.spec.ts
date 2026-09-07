import { ConfigService } from '@nestjs/config';
import { WeaviateService } from './weaviate.service.js';
import type { SearchChunk } from '../types.js';

describe('WeaviateService - Batch Ingestion', () => {
  let service: WeaviateService;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;

    const config = new ConfigService({
      WEAVIATE_HTTP_URL: 'http://localhost:8080',
    });
    service = new WeaviateService(config);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 0 when upsertBatch is called with an empty list', async () => {
    const result = await service.upsertBatch([]);
    expect(result).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('batches chunks and sends POST to /v1/batch/objects with tenant configuration', async () => {
    // 1. Schema check returns ok
    // 2. Tenant creation returns ok
    // 3. Batch write returns 200
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes('/v1/schema/Chunk')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ properties: [{ name: 'pageNum' }] }),
        });
      }
      if (urlStr.includes('/v1/schema/Chunk/tenants')) {
        return Promise.resolve({ ok: true, status: 200 });
      }
      if (urlStr.includes('/v1/batch/objects')) {
        const body = JSON.parse(init?.body as string) as {
          objects: Array<{
            tenant: string;
            properties: {
              pageNum: number;
              coordinates?: number[];
              elementType?: string;
            };
          }>;
        };
        expect(body.objects).toHaveLength(2);
        expect(body.objects[0]?.tenant).toBe('graph-test');
        expect(body.objects[0]?.properties.pageNum).toBe(1);
        expect(body.objects[0]?.properties.coordinates).toEqual([
          50, 44, 300, 20,
        ]);
        expect(body.objects[0]?.properties.elementType).toBe('heading');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([]),
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    const chunks: SearchChunk[] = [
      {
        graphId: 'graph-test',
        sourceId: 'src-1',
        sourceName: 'Syllabus.pdf',
        nodeId: 'node-1',
        content: 'Overview of distributed systems and consensus.',
        context: 'Full context of distributed systems.',
        startChar: 0,
        endChar: 45,
        pageNum: 1,
        coordinates: [50, 44, 300, 20],
        elementType: 'heading',
        score: 0.9,
      },
      {
        graphId: 'graph-test',
        sourceId: 'src-1',
        sourceName: 'Syllabus.pdf',
        nodeId: 'node-1',
        content: 'Raft consensus algorithm principles and leader election.',
        context: 'Full context of consensus.',
        startChar: 46,
        endChar: 102,
        pageNum: 2,
        score: 0.85,
      },
    ];

    const vectors = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];

    const indexedCount = await service.upsertBatch(chunks, vectors);
    expect(indexedCount).toBe(2);
  });

  it('performs hybridSearch with single nodeId using Equal pre-filter', async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes('/v1/schema/Chunk')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ properties: [{ name: 'pageNum' }] }),
        });
      }
      if (urlStr.includes('/v1/graphql')) {
        const body = JSON.parse(init?.body as string) as { query: string };
        expect(body.query).toContain('tenant: "graph-test"');
        expect(body.query).toContain('path: ["nodeId"]');
        expect(body.query).toContain('operator: Equal');
        expect(body.query).toContain('valueText: "node-1"');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: {
                Get: {
                  Chunk: [
                    {
                      graphId: 'graph-test',
                      sourceId: 'src-1',
                      sourceName: 'Syllabus.pdf',
                      nodeId: 'node-1',
                      content: 'Consensus algorithms in distributed systems.',
                      context: 'Full consensus algorithms context.',
                      startChar: 0,
                      endChar: 40,
                      pageNum: 1,
                      _additional: { score: '0.92', vector: [0.1, 0.2, 0.3] },
                    },
                  ],
                },
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    const results = await service.hybridSearch(
      'graph-test',
      'consensus',
      ['node-1'],
      [0.1, 0.2, 0.3],
      10,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.nodeId).toBe('node-1');
    expect(results[0]?.score).toBe(0.92);
    expect(results[0]?.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('performs hybridSearch with multiple nodeIds using ContainsAny pre-filter', async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes('/v1/schema/Chunk')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ properties: [{ name: 'pageNum' }] }),
        });
      }
      if (urlStr.includes('/v1/graphql')) {
        const body = JSON.parse(init?.body as string) as { query: string };
        expect(body.query).toContain('operator: ContainsAny');
        expect(body.query).toContain('valueText: ["node-1","node-2"]');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: {
                Get: {
                  Chunk: [
                    {
                      graphId: 'graph-test',
                      sourceId: 'src-1',
                      sourceName: 'Syllabus.pdf',
                      nodeId: 'node-2',
                      content: 'Raft protocol states and heartbeat timers.',
                      context: 'Raft protocol states context.',
                      startChar: 50,
                      endChar: 95,
                      pageNum: 2,
                      _additional: { score: '0.88' },
                    },
                  ],
                },
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    const results = await service.hybridSearch(
      'graph-test',
      'raft',
      ['node-1', 'node-2'],
      [0.1, 0.2, 0.3],
      10,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.nodeId).toBe('node-2');
    expect(results[0]?.score).toBe(0.88);
  });

  it('performs vectorSearch using pre-filter and strips vector property', async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes('/v1/schema/Chunk')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ properties: [{ name: 'pageNum' }] }),
        });
      }
      if (urlStr.includes('/v1/graphql')) {
        const body = JSON.parse(init?.body as string) as { query: string };
        expect(body.query).toContain('nearVector:');
        expect(body.query).toContain('operator: Equal');
        expect(body.query).toContain('valueText: "adjacent-node"');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: {
                Get: {
                  Chunk: [
                    {
                      graphId: 'graph-test',
                      sourceId: 'src-2',
                      sourceName: 'Paxos.pdf',
                      nodeId: 'adjacent-node',
                      content: 'Paxos consensus quorum mechanics.',
                      context: 'Paxos context.',
                      startChar: 0,
                      endChar: 35,
                      pageNum: 3,
                      _additional: { score: '0.79' },
                    },
                  ],
                },
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    const results = await service.vectorSearch(
      'graph-test',
      [0.1, 0.2, 0.3],
      ['adjacent-node'],
      5,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.nodeId).toBe('adjacent-node');
    expect((results[0] as { vector?: unknown }).vector).toBeUndefined();
  });
});
