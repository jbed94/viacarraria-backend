import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const MAX_EMBEDDING_TEXT_CHARS = 1000;

export type TeiModelInfo = {
  modelId?: string;
  maxInputTokens: number;
  maxBatchTokens?: number;
  maxTextChars: number;
};

@Injectable()
export class EmbeddingService {
  private readonly baseUrl: string;
  private modelInfo?: TeiModelInfo;
  private isNegotiated = false;
  private negotiationPromise?: Promise<TeiModelInfo>;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('TEI_URL').replace(/\/$/, '');
  }

  getModelInfo(): TeiModelInfo | undefined {
    return this.modelInfo;
  }

  getMaxInputTokens(): number {
    return this.modelInfo?.maxInputTokens ?? 256;
  }

  getMaxTextChars(): number {
    return this.modelInfo?.maxTextChars ?? MAX_EMBEDDING_TEXT_CHARS;
  }

  async negotiateModelLimits(): Promise<TeiModelInfo> {
    if (this.isNegotiated && this.modelInfo) {
      return this.modelInfo;
    }
    if (this.negotiationPromise) {
      return this.negotiationPromise;
    }

    this.negotiationPromise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch(`${this.baseUrl}/info`, {
          method: 'GET',
          signal: controller.signal,
        });

        if (response.ok) {
          const data = (await response.json()) as Record<string, unknown>;
          const rawTokens =
            typeof data['max_input_length'] === 'number'
              ? data['max_input_length']
              : typeof data['max_input_tokens'] === 'number'
                ? data['max_input_tokens']
                : typeof data['max_sequence_length'] === 'number'
                  ? data['max_sequence_length']
                  : 256;

          const maxInputTokens = Math.max(64, rawTokens);
          const maxTextChars = Math.max(
            1000,
            Math.min(32000, maxInputTokens * 4),
          );

          this.modelInfo = {
            modelId:
              typeof data['model_id'] === 'string'
                ? data['model_id']
                : undefined,
            maxInputTokens,
            maxBatchTokens:
              typeof data['max_batch_tokens'] === 'number'
                ? data['max_batch_tokens']
                : undefined,
            maxTextChars,
          };
        } else {
          this.modelInfo = {
            maxInputTokens: 256,
            maxTextChars: MAX_EMBEDDING_TEXT_CHARS,
          };
        }
      } catch {
        this.modelInfo = {
          maxInputTokens: 256,
          maxTextChars: MAX_EMBEDDING_TEXT_CHARS,
        };
      } finally {
        clearTimeout(timeout);
        this.isNegotiated = true;
        this.negotiationPromise = undefined;
      }

      return this.modelInfo;
    })();

    return this.negotiationPromise;
  }

  async embed(text: string): Promise<number[] | undefined> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<Array<number[] | undefined>> {
    if (texts.length === 0) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const maxChars = this.getMaxTextChars();
      const sanitizedTexts = texts.map((t) =>
        typeof t === 'string' && t.length > maxChars ? t.slice(0, maxChars) : t,
      );

      const response = await fetch(`${this.baseUrl}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          inputs: sanitizedTexts,
          truncate: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return new Array(texts.length).fill(undefined);
      }
      const body = JSON.parse(await response.text()) as unknown;
      const values = isUnknownArray(body)
        ? body
        : isEmbeddingsResponse(body)
          ? body.embeddings
          : undefined;

      if (!Array.isArray(values)) {
        return new Array(texts.length).fill(undefined);
      }

      return texts.map((_, i) => {
        const item = values[i];
        return Array.isArray(item) &&
          item.every((value) => typeof value === 'number')
          ? item
          : undefined;
      });
    } catch {
      return new Array(texts.length).fill(undefined);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isEmbeddingsResponse(
  value: unknown,
): value is { embeddings: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'embeddings' in value &&
    Array.isArray(value.embeddings)
  );
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
