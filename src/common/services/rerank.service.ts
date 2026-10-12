import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type RerankResult = {
  index: number;
  score: number;
};

export type RerankBatchItem = {
  query: string;
  texts: string[];
};

export const DEFAULT_RERANK_TIMEOUT_MS = 500;

@Injectable()
export class RerankService {
  private readonly logger = new Logger(RerankService.name);
  private readonly baseUrl?: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    const rawUrl =
      typeof config?.get === 'function'
        ? config.get<string>('TEI_RERANK_URL')
        : undefined;
    this.baseUrl = rawUrl?.trim()
      ? rawUrl.trim().replace(/\/$/, '')
      : undefined;

    const rawTimeout =
      typeof config?.get === 'function'
        ? config.get<string | number>('TEI_RERANK_TIMEOUT_MS')
        : undefined;

    const parsedTimeout =
      typeof rawTimeout === 'number'
        ? rawTimeout
        : rawTimeout
          ? parseInt(String(rawTimeout), 10)
          : DEFAULT_RERANK_TIMEOUT_MS;

    this.timeoutMs =
      !isNaN(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : DEFAULT_RERANK_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  getTimeoutMs(): number {
    return this.timeoutMs;
  }

  async checkHealth(): Promise<boolean> {
    if (!this.baseUrl) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async rerank(
    query: string,
    texts: string[],
  ): Promise<RerankResult[] | undefined> {
    if (!this.baseUrl || texts.length === 0 || !query.trim()) {
      return undefined;
    }

    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

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

      const elapsed = Date.now() - start;
      this.logger.debug(
        `Reranked ${texts.length} passages in ${elapsed}ms for query "${query.slice(0, 40)}"`,
      );

      return results;
    } catch (error: unknown) {
      this.logger.warn(
        `TEI reranker invocation failed (timeout or error): ${String(error)}`,
      );
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  async rerankBatch(
    requests: RerankBatchItem[],
  ): Promise<Array<RerankResult[] | undefined>> {
    if (!this.baseUrl || requests.length === 0) {
      return requests.map(() => undefined);
    }

    const start = Date.now();
    const results = await Promise.all(
      requests.map((req) => this.rerank(req.query, req.texts)),
    );

    const elapsed = Date.now() - start;
    const totalTexts = requests.reduce((acc, r) => acc + r.texts.length, 0);
    this.logger.debug(
      `Reranked batch of ${requests.length} queries (${totalTexts} passages) in ${elapsed}ms`,
    );

    return results;
  }
}
