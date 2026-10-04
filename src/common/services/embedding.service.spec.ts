import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from './embedding.service.js';

describe('EmbeddingService', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('embeds a single text successfully via embedBatch', async () => {
    const mockVector = [0.12, 0.34, 0.56];
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify([mockVector])),
    });
    globalThis.fetch = fetchMock;

    const service = new EmbeddingService({
      getOrThrow: jest.fn().mockReturnValue('http://tei-embeddings:80'),
    } as unknown as ConfigService);

    const result = await service.embed('sample passage');
    expect(result).toEqual(mockVector);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://tei-embeddings:80/embed',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: ['sample passage'], truncate: true }),
      }),
    );
  });

  it('embeds multiple texts in a single batch request via embedBatch', async () => {
    const mockVectors = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
      [0.7, 0.8, 0.9],
    ];
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(mockVectors)),
    });
    globalThis.fetch = fetchMock;

    const service = new EmbeddingService({
      getOrThrow: jest.fn().mockReturnValue('http://tei-embeddings:80/'),
    } as unknown as ConfigService);

    const results = await service.embedBatch(['text 1', 'text 2', 'text 3']);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual(mockVectors[0]);
    expect(results[1]).toEqual(mockVectors[1]);
    expect(results[2]).toEqual(mockVectors[2]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://tei-embeddings:80/embed',
      expect.objectContaining({
        body: JSON.stringify({
          inputs: ['text 1', 'text 2', 'text 3'],
          truncate: true,
        }),
      }),
    );
  });

  it('defensively truncates inputs exceeding MAX_EMBEDDING_TEXT_CHARS before calling TEI', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify([[0.1, 0.2]])),
    });
    globalThis.fetch = fetchMock;

    const service = new EmbeddingService({
      getOrThrow: jest.fn().mockReturnValue('http://tei-embeddings:80'),
    } as unknown as ConfigService);

    const longText = 'a'.repeat(1500);
    await service.embed(longText);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://tei-embeddings:80/embed',
      expect.objectContaining({
        body: JSON.stringify({
          inputs: ['a'.repeat(1000)],
          truncate: true,
        }),
      }),
    );
  });

  it('returns empty array when embedBatch is called with empty array', async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    const service = new EmbeddingService({
      getOrThrow: jest.fn().mockReturnValue('http://tei-embeddings:80'),
    } as unknown as ConfigService);

    const results = await service.embedBatch([]);
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles server errors gracefully by returning undefined for all inputs', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    const service = new EmbeddingService({
      getOrThrow: jest.fn().mockReturnValue('http://tei-embeddings:80'),
    } as unknown as ConfigService);

    const results = await service.embedBatch(['text 1', 'text 2']);
    expect(results).toEqual([undefined, undefined]);
  });

  it('handles network exceptions gracefully without throwing', async () => {
    globalThis.fetch = jest
      .fn()
      .mockRejectedValue(new Error('Connection timeout'));

    const service = new EmbeddingService({
      getOrThrow: jest.fn().mockReturnValue('http://tei-embeddings:80'),
    } as unknown as ConfigService);

    const results = await service.embedBatch(['text 1']);
    expect(results).toEqual([undefined]);
  });

  describe('negotiateModelLimits', () => {
    it('successfully queries /info and scales maxTextChars based on max_input_length', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            model_id: 'google/embeddinggemma-300m',
            max_input_length: 2048,
            max_batch_tokens: 16384,
          }),
      });
      globalThis.fetch = fetchMock;

      const service = new EmbeddingService({
        getOrThrow: jest.fn().mockReturnValue('http://tei-embeddings:80'),
      } as unknown as ConfigService);

      const info = await service.negotiateModelLimits();
      expect(info.modelId).toBe('google/embeddinggemma-300m');
      expect(info.maxInputTokens).toBe(2048);
      expect(info.maxTextChars).toBe(8192); // 2048 * 4
      expect(service.getMaxInputTokens()).toBe(2048);
      expect(service.getMaxTextChars()).toBe(8192);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://tei-embeddings:80/info',
        expect.any(Object),
      );
    });

    it('falls back to default 256 tokens and 1000 chars when /info responds with error', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });
      globalThis.fetch = fetchMock;

      const service = new EmbeddingService({
        getOrThrow: jest.fn().mockReturnValue('http://tei-embeddings:80'),
      } as unknown as ConfigService);

      const info = await service.negotiateModelLimits();
      expect(info.maxInputTokens).toBe(256);
      expect(info.maxTextChars).toBe(1000);
      expect(service.getMaxInputTokens()).toBe(256);
      expect(service.getMaxTextChars()).toBe(1000);
    });

    it('falls back to default limits when /info request fails with network exception', async () => {
      const fetchMock = jest.fn().mockRejectedValue(new Error('Network error'));
      globalThis.fetch = fetchMock;

      const service = new EmbeddingService({
        getOrThrow: jest.fn().mockReturnValue('http://tei-embeddings:80'),
      } as unknown as ConfigService);

      const info = await service.negotiateModelLimits();
      expect(info.maxInputTokens).toBe(256);
      expect(info.maxTextChars).toBe(1000);
    });

    it('applies negotiated sequence length when truncating texts in embed', async () => {
      const fetchMock = jest.fn().mockImplementation((url: string) => {
        if (url.endsWith('/info')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                model_id: 'google/embeddinggemma-300m',
                max_input_length: 500,
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify([[0.1, 0.2]])),
        });
      });
      globalThis.fetch = fetchMock;

      const service = new EmbeddingService({
        getOrThrow: jest.fn().mockReturnValue('http://tei-embeddings:80'),
      } as unknown as ConfigService);

      await service.negotiateModelLimits();
      expect(service.getMaxTextChars()).toBe(2000); // 500 * 4

      const longText = 'b'.repeat(2500);
      await service.embed(longText);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://tei-embeddings:80/embed',
        expect.objectContaining({
          body: JSON.stringify({
            inputs: ['b'.repeat(2000)],
            truncate: true,
          }),
        }),
      );
    });
  });
});
