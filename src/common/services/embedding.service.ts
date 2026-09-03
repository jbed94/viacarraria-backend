import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmbeddingService {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('TEI_URL').replace(/\/$/, '');
  }

  async embed(text: string): Promise<number[] | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${this.baseUrl}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: [text] }),
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const body = JSON.parse(await response.text()) as unknown;
      const values = isUnknownArray(body)
        ? body
        : isEmbeddingsResponse(body)
          ? body.embeddings
          : undefined;
      const vector = values?.[0];
      return Array.isArray(vector) &&
        vector.every((value) => typeof value === 'number')
        ? vector
        : undefined;
    } catch {
      return undefined;
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
