import { ConfigService } from '@nestjs/config';
import { RerankService } from './rerank.service.js';

describe('RerankService', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('reports configured state correctly based on TEI_RERANK_URL', () => {
    const unconfigured = new RerankService({
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService);
    expect(unconfigured.isConfigured()).toBe(false);

    const configured = new RerankService({
      get: jest.fn().mockReturnValue('http://rerank-engine:80'),
    } as unknown as ConfigService);
    expect(configured.isConfigured()).toBe(true);
  });

  it('returns undefined early if not configured or inputs are empty', async () => {
    const service = new RerankService({
      get: jest.fn().mockReturnValue(''),
    } as unknown as ConfigService);

    expect(await service.rerank('test query', ['sample text'])).toBeUndefined();

    const configured = new RerankService({
      get: jest.fn().mockReturnValue('http://rerank-engine:80'),
    } as unknown as ConfigService);

    expect(await configured.rerank('', ['sample text'])).toBeUndefined();
    expect(await configured.rerank('test query', [])).toBeUndefined();
  });

  it('calls TEI /rerank and returns parsed scores on success', async () => {
    const mockResponse = [
      { index: 1, score: 0.94 },
      { index: 0, score: 0.42 },
    ];

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockResponse),
    });
    globalThis.fetch = fetchMock;

    const service = new RerankService({
      get: jest.fn().mockReturnValue('http://rerank-engine:80/'),
    } as unknown as ConfigService);

    const result = await service.rerank('how to sort an array', [
      'Sorting algorithms include quicksort and mergesort.',
      'To sort an array, use array.sort() with a comparator.',
    ]);

    expect(result).toEqual([
      { index: 1, score: 0.94 },
      { index: 0, score: 0.42 },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://rerank-engine:80/rerank',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'how to sort an array',
          texts: [
            'Sorting algorithms include quicksort and mergesort.',
            'To sort an array, use array.sort() with a comparator.',
          ],
          truncate: true,
        }),
      }),
    );
  });

  it('handles server errors gracefully without throwing', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const service = new RerankService({
      get: jest.fn().mockReturnValue('http://rerank-engine:80'),
    } as unknown as ConfigService);

    const result = await service.rerank('query', ['passage']);
    expect(result).toBeUndefined();
  });

  it('handles network errors gracefully without throwing', async () => {
    globalThis.fetch = jest
      .fn()
      .mockRejectedValue(new Error('Connection refused'));

    const service = new RerankService({
      get: jest.fn().mockReturnValue('http://rerank-engine:80'),
    } as unknown as ConfigService);

    const result = await service.rerank('query', ['passage']);
    expect(result).toBeUndefined();
  });

  it('respects TEI_RERANK_TIMEOUT_MS or defaults to 500ms', () => {
    const defaultService = new RerankService({
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService);
    expect(defaultService.getTimeoutMs()).toBe(500);

    const customService = new RerankService({
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'TEI_RERANK_URL') return 'http://rerank-engine:80';
        if (key === 'TEI_RERANK_TIMEOUT_MS') return 250;
        return undefined;
      }),
    } as unknown as ConfigService);
    expect(customService.getTimeoutMs()).toBe(250);
  });

  it('probes health via checkHealth()', async () => {
    const unconfigured = new RerankService({
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService);
    expect(await unconfigured.checkHealth()).toBe(false);

    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    const healthyService = new RerankService({
      get: jest.fn().mockReturnValue('http://rerank-engine:80'),
    } as unknown as ConfigService);
    expect(await healthyService.checkHealth()).toBe(true);

    globalThis.fetch = jest.fn().mockRejectedValue(new Error('Network down'));
    expect(await healthyService.checkHealth()).toBe(false);
  });

  describe('rerankBatch', () => {
    it('returns empty array when requests is empty', async () => {
      const service = new RerankService({
        get: jest.fn().mockReturnValue('http://rerank-engine:80'),
      } as unknown as ConfigService);
      expect(await service.rerankBatch([])).toEqual([]);
    });

    it('returns array of undefined when service is unconfigured', async () => {
      const service = new RerankService({
        get: jest.fn().mockReturnValue(''),
      } as unknown as ConfigService);
      const results = await service.rerankBatch([
        { query: 'q1', texts: ['t1'] },
        { query: 'q2', texts: ['t2'] },
      ]);
      expect(results).toEqual([undefined, undefined]);
    });

    it('processes batch requests in parallel and returns scores for each query', async () => {
      const fetchMock = jest.fn().mockImplementation((url, init) => {
        const body = JSON.parse(init.body);
        if (body.query === 'first query') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve([{ index: 0, score: 0.95 }]),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ index: 1, score: 0.88 }]),
        });
      });
      globalThis.fetch = fetchMock;

      const service = new RerankService({
        get: jest.fn().mockReturnValue('http://rerank-engine:80'),
      } as unknown as ConfigService);

      const results = await service.rerankBatch([
        { query: 'first query', texts: ['passage A'] },
        { query: 'second query', texts: ['passage B', 'passage C'] },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual([{ index: 0, score: 0.95 }]);
      expect(results[1]).toEqual([{ index: 1, score: 0.88 }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('handles individual batch item failures gracefully', async () => {
      const fetchMock = jest.fn().mockImplementation((url, init) => {
        const body = JSON.parse(init.body);
        if (body.query === 'fail query') {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ index: 0, score: 0.91 }]),
        });
      });
      globalThis.fetch = fetchMock;

      const service = new RerankService({
        get: jest.fn().mockReturnValue('http://rerank-engine:80'),
      } as unknown as ConfigService);

      const results = await service.rerankBatch([
        { query: 'fail query', texts: ['passage X'] },
        { query: 'ok query', texts: ['passage Y'] },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]).toBeUndefined();
      expect(results[1]).toEqual([{ index: 0, score: 0.91 }]);
    });
  });
});
