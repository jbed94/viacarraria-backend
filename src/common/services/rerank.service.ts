import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type RerankResult = {
  index: number;
  score: number;
};

@Injectable()
export class RerankService {
  private readonly logger = new Logger(RerankService.name);
  private readonly baseUrl?: string;

  constructor(config: ConfigService) {
    const rawUrl = config.get<string>('TEI_RERANK_URL');
    this.baseUrl = rawUrl?.trim()
      ? rawUrl.trim().replace(/\/$/, '')
      : undefined;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  async rerank(
    query: string,
    texts: string[],
  ): Promise<RerankResult[] | undefined> {
    if (!this.baseUrl || texts.length === 0 || !query.trim()) {
      return undefined;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query,
          texts,
          truncate: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          `TEI reranker responded with status ${response.status}: ${response.statusText}`,
        );
        return undefined;
      }

      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) {
        return undefined;
      }

      const results: RerankResult[] = [];
      for (const item of body) {
        if (typeof item === 'object' && item !== null) {
          const rec = item as Record<string, unknown>;
          if (
            typeof rec['index'] === 'number' &&
            typeof rec['score'] === 'number'
          ) {
            results.push({ index: rec['index'], score: rec['score'] });
          }
        }
      }

      return results;
    } catch (error: unknown) {
      this.logger.warn(`Failed to connect to TEI reranker: ${String(error)}`);
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}
