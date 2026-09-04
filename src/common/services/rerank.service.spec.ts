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
});
