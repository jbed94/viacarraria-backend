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
        return Promise.resolve({ ok: true, status: 200 });
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
});
