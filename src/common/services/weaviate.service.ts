import { createHash } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { SearchChunk, SubscriptionTier } from '../types.js';
import { isTabularQuery } from '../../modules/search/search.utils.js';
import { SimilarityQueueService } from './similarity-queue.service.js';

export type VectorizedSearchChunk = SearchChunk & { vector?: number[] };

export type VectorSearchQuery = {
  id: string;
  vector: number[];
  adjacentNodeIds: string[];
  limit: number;
  minScore?: number;
};

const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

export function generateChunkUuid(
  sourceId: string,
  startChar: number,
  endChar: number,
): string {
  const nsBuffer = Buffer.from(NAMESPACE_URL.replace(/-/g, ''), 'hex');
  const nameBuffer = Buffer.from(`${sourceId}:${startChar}:${endChar}`, 'utf8');
  const hash = createHash('sha1')
    .update(Buffer.concat([nsBuffer, nameBuffer]))
    .digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50; // version 5
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80; // variant RFC 4122
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

@Injectable()
export class WeaviateService {
  private readonly baseUrl: string;
  private readonly pqEnabled: boolean;
  private readonly pqTrainingLimit: number;
  private readonly pqSegments: number;

  private readonly logger = new Logger(WeaviateService.name);

  constructor(
    config: ConfigService,
    @Optional() private readonly similarityQueue?: SimilarityQueueService,
  ) {
    this.baseUrl = config
      .getOrThrow<string>('WEAVIATE_HTTP_URL')
      .replace(/\/$/, '');
    this.pqEnabled =
      config.get<string>('WEAVIATE_PQ_ENABLED', 'false') === 'true';
    this.pqTrainingLimit = Number.parseInt(
      config.get<string>('WEAVIATE_PQ_TRAINING_LIMIT', '10000'),
      10,
    );
    this.pqSegments = Number.parseInt(
      config.get<string>('WEAVIATE_PQ_SEGMENTS', '64'),
      10,
    );
  }

  getPqConfig(): { enabled: boolean; trainingLimit: number; segments: number } {
    return {
      enabled: this.pqEnabled,
      trainingLimit: this.pqTrainingLimit,
      segments: this.pqSegments,
    };
  }

  async isReady(): Promise<boolean> {
    try {
      const response = await this.request('/v1/.well-known/ready');
      return response.ok;
    } catch {
      return false;
    }
  }

  async upsertChunk(chunk: SearchChunk, vector?: number[]): Promise<void> {
    await this.ensureSchema();
    const objectId = generateChunkUuid(
      chunk.sourceId,
      chunk.startChar,
      chunk.endChar,
    );
    const response = await this.request('/v1/objects', {
      method: 'POST',
      body: JSON.stringify({
        class: 'Chunk',
        id: objectId,
        tenant: chunk.graphId,
        properties: {
          graphId: chunk.graphId,
          sourceId: chunk.sourceId,
          sourceName: chunk.sourceName,
          nodeId: chunk.nodeId,
          content: chunk.content,
          context: chunk.context,
          startChar: chunk.startChar,
          endChar: chunk.endChar,
          ...(chunk.imageAssetUrl
            ? { imageAssetUrl: chunk.imageAssetUrl }
            : {}),
          ...(chunk.lqip ? { lqip: chunk.lqip } : {}),
        },
        vector,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Weaviate object write failed (${response.status}): ${errorText}`,
      );
    }
  }

  async upsertBatch(
    chunks: SearchChunk[],
    vectors?: Array<number[] | undefined>,
  ): Promise<number> {
    if (chunks.length === 0) {
      return 0;
    }
    await this.ensureSchema();

    const uniqueGraphIds = [...new Set(chunks.map((chunk) => chunk.graphId))];
    await Promise.all(
      uniqueGraphIds.map((graphId) => this.ensureTenant(graphId)),
    );

    const objects = chunks.map((chunk, index) => {
      const vector = vectors?.[index];
      const objectId = generateChunkUuid(
        chunk.sourceId,
        chunk.startChar,
        chunk.endChar,
      );
      return {
        class: 'Chunk',
        id: objectId,
        tenant: chunk.graphId,
        properties: {
          graphId: chunk.graphId,
          sourceId: chunk.sourceId,
          sourceName: chunk.sourceName,
          nodeId: chunk.nodeId,
          content: chunk.content,
          context: chunk.context,
          startChar: chunk.startChar,
          endChar: chunk.endChar,
          pageNum: chunk.pageNum ?? 1,
          ...(chunk.coordinates?.length
            ? { coordinates: chunk.coordinates }
            : {}),
          ...(chunk.elementType ? { elementType: chunk.elementType } : {}),
          ...(chunk.imageAssetUrl
            ? { imageAssetUrl: chunk.imageAssetUrl }
            : {}),
          ...(chunk.lqip ? { lqip: chunk.lqip } : {}),
        },
        ...(vector?.length ? { vector } : {}),
      };
    });

    const batchSize = 100;
    let indexedCount = 0;

    for (let i = 0; i < objects.length; i += batchSize) {
      const slice = objects.slice(i, i + batchSize);
      const response = await this.request('/v1/batch/objects', {
        method: 'POST',
        body: JSON.stringify({ objects: slice }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
          `Weaviate batch write failed with status ${response.status}: ${errorText}`,
        );
      }

      const body =
        typeof response.json === 'function'
          ? ((await response.json().catch(() => null)) as Array<{
              result?: { errors?: { error?: Array<{ message: string }> } };
            }> | null)
          : null;

      if (Array.isArray(body)) {
        const individualErrors = body.flatMap(
          (item) => item.result?.errors?.error?.map((e) => e.message) ?? [],
        );
        if (individualErrors.length > 0) {
          this.logger.warn(
            `Weaviate batch write encountered ${individualErrors.length} item error(s): ${individualErrors.slice(0, 3).join('; ')}`,
          );
        }
      }

      indexedCount += slice.length;
    }

    return indexedCount;
  }

  async ensureTenant(graphId: string): Promise<void> {
    try {
      await this.ensureSchema();
      await this.request('/v1/schema/Chunk/tenants', {
        method: 'POST',
        body: JSON.stringify([{ name: graphId }]),
      });
    } catch {
      // Tenant may already exist
    }
  }

  async deleteTenant(graphId: string): Promise<void> {
    try {
      await this.request('/v1/schema/Chunk/tenants', {
        method: 'DELETE',
        body: JSON.stringify([graphId]),
      });
    } catch {
      // Non-blocking if tenant was already deleted
    }
  }

  async hybridSearch(
    graphId: string,
    query: string,
    selectedNodeIds: string[],
    vector: number[],
    limit = 25,
    minScore?: number,
    tier?: SubscriptionTier,
  ): Promise<VectorizedSearchChunk[]> {
    if (this.similarityQueue) {
      return this.similarityQueue.enqueue(tier, () =>
        this.executeHybridSearch(
          graphId,
          query,
          selectedNodeIds,
          vector,
          limit,
          minScore,
        ),
      );
    }
    return this.executeHybridSearch(
      graphId,
      query,
      selectedNodeIds,
      vector,
      limit,
      minScore,
    );
  }

  private async executeHybridSearch(
    graphId: string,
    query: string,
    selectedNodeIds: string[],
    vector: number[],
    limit = 25,
    minScore?: number,
  ): Promise<VectorizedSearchChunk[]> {
    if (selectedNodeIds.length === 0) {
      return [];
    }
    await this.ensureSchema();
    const candidateLimit = isTabularQuery(query)
      ? Math.min(limit * 2, 50)
      : limit;
    const nodeFilter = this.buildNodeFilter(selectedNodeIds);
    const graphQuery = `{
      Get {
        Chunk(
          tenant: ${JSON.stringify(graphId)}
          hybrid: { query: ${JSON.stringify(query)}, vector: ${JSON.stringify(vector)}, alpha: 0.7 }
          where: ${nodeFilter}
          limit: ${candidateLimit}
        ) {
          graphId sourceId sourceName nodeId content context startChar endChar pageNum coordinates elementType imageAssetUrl lqip
          _additional { score vector }
        }
      }
    }`;
    const response = await this.request('/v1/graphql', {
      method: 'POST',
      body: JSON.stringify({ query: graphQuery }),
    });
    if (!response.ok) {
      throw new Error(`Weaviate search failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      data?: { Get?: { Chunk?: Array<Record<string, unknown>> } };
      errors?: Array<{ message: string }>;
    };
    if (
      body.errors?.some((error) => error.message.includes('tenant not found'))
    ) {
      return [];
    }
    const chunks = this.toSearchChunks(
      body.data?.Get?.Chunk ?? [],
      graphId,
    ).filter((chunk) => selectedNodeIds.includes(chunk.nodeId));
    if (minScore !== undefined) {
      return chunks.filter((chunk) => chunk.score >= minScore);
    }
    return chunks;
  }

  async vectorSearch(
    graphId: string,
    vector: number[],
    adjacentNodeIds: string[],
    limit: number,
    minScore?: number,
    tier?: SubscriptionTier,
  ): Promise<VectorizedSearchChunk[]> {
    if (this.similarityQueue) {
      return this.similarityQueue.enqueue(tier, () =>
        this.executeVectorSearch(
          graphId,
          vector,
          adjacentNodeIds,
          limit,
          minScore,
        ),
      );
    }
    return this.executeVectorSearch(
      graphId,
      vector,
      adjacentNodeIds,
      limit,
      minScore,
    );
  }

  private async executeVectorSearch(
    graphId: string,
    vector: number[],
    adjacentNodeIds: string[],
    limit: number,
    minScore?: number,
  ): Promise<VectorizedSearchChunk[]> {
    if (adjacentNodeIds.length === 0 || limit < 1) {
      return [];
    }
    await this.ensureSchema();
    const nodeFilter = this.buildNodeFilter(adjacentNodeIds);
    const graphQuery = `{
      Get {
        Chunk(
          tenant: ${JSON.stringify(graphId)}
          nearVector: { vector: ${JSON.stringify(vector)} }
          where: ${nodeFilter}
          limit: ${limit}
        ) {
          graphId sourceId sourceName nodeId content context startChar endChar pageNum coordinates elementType imageAssetUrl lqip
          _additional { score vector }
        }
      }
    }`;
    const response = await this.request('/v1/graphql', {
      method: 'POST',
      body: JSON.stringify({ query: graphQuery }),
    });
    if (!response.ok) {
      throw new Error(`Weaviate extended search failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      data?: { Get?: { Chunk?: Array<Record<string, unknown>> } };
      errors?: Array<{ message: string }>;
    };
    if (
      body.errors?.some((error) => error.message.includes('tenant not found'))
    ) {
      return [];
    }
    const chunks = this.toSearchChunks(
      body.data?.Get?.Chunk ?? [],
      graphId,
    ).filter((chunk) => adjacentNodeIds.includes(chunk.nodeId));
    if (minScore !== undefined) {
      return chunks.filter((chunk) => chunk.score >= minScore);
    }
    return chunks;
  }

  async multiVectorSearch(
    graphId: string,
    queries: VectorSearchQuery[],
    tier?: SubscriptionTier,
  ): Promise<Map<string, VectorizedSearchChunk[]>> {
    if (this.similarityQueue) {
      return this.similarityQueue.enqueue(tier, () =>
        this.executeMultiVectorSearch(graphId, queries),
      );
    }
    return this.executeMultiVectorSearch(graphId, queries);
  }

  private async executeMultiVectorSearch(
    graphId: string,
    queries: VectorSearchQuery[],
  ): Promise<Map<string, VectorizedSearchChunk[]>> {
    const resultMap = new Map<string, VectorizedSearchChunk[]>();
    for (const q of queries) {
      resultMap.set(q.id, []);
    }

    const validQueries = queries.filter(
      (q) =>
        q.adjacentNodeIds.length > 0 &&
        q.limit > 0 &&
        Array.isArray(q.vector) &&
        q.vector.length > 0,
    );
    if (validQueries.length === 0) {
      return resultMap;
    }

    await this.ensureSchema();

    const aliasMap = new Map<string, VectorSearchQuery>();
    const queryBlocks: string[] = [];

    validQueries.forEach((q, index) => {
      const alias = `b_${index}`;
      aliasMap.set(alias, q);
      const nodeFilter = this.buildNodeFilter(q.adjacentNodeIds);
      queryBlocks.push(`
        ${alias}: Chunk(
          tenant: ${JSON.stringify(graphId)}
          nearVector: { vector: ${JSON.stringify(q.vector)} }
          where: ${nodeFilter}
          limit: ${q.limit}
        ) {
          graphId sourceId sourceName nodeId content context startChar endChar pageNum coordinates elementType imageAssetUrl lqip
          _additional { score vector }
        }
      `);
    });

    const graphQuery = `{
      Get {
        ${queryBlocks.join('\n')}
      }
    }`;

    const response = await this.request('/v1/graphql', {
      method: 'POST',
      body: JSON.stringify({ query: graphQuery }),
    });

    if (!response.ok) {
      throw new Error(`Weaviate multi-search failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      data?: { Get?: Record<string, Array<Record<string, unknown>>> };
      errors?: Array<{ message: string }>;
    };

    if (
      body.errors?.some((error) => error.message.includes('tenant not found'))
    ) {
      return resultMap;
    }

    for (const [alias, q] of aliasMap.entries()) {
      const rawChunks = body.data?.Get?.[alias] ?? [];
      let chunks = this.toSearchChunks(rawChunks, graphId).filter((chunk) =>
        q.adjacentNodeIds.includes(chunk.nodeId),
      );
      if (q.minScore !== undefined) {
        chunks = chunks.filter((chunk) => chunk.score >= q.minScore!);
      }
      resultMap.set(q.id, chunks);
    }

    return resultMap;
  }

  private toSearchChunks(
    items: Array<Record<string, unknown>>,
    graphId: string,
  ): VectorizedSearchChunk[] {
    return items.flatMap((item) => {
      const nodeId = item.nodeId;
      const content = item.content;
      const sourceId = item.sourceId;
      const sourceName = item.sourceName;
      if (
        typeof nodeId !== 'string' ||
        typeof content !== 'string' ||
        typeof sourceId !== 'string' ||
        typeof sourceName !== 'string'
      ) {
        return [];
      }
      const additional = item._additional as
        { score?: string; vector?: unknown[] } | undefined;
      const vector = Array.isArray(additional?.vector)
        ? additional.vector.filter(
            (value): value is number => typeof value === 'number',
          )
        : undefined;
      return [
        {
          nodeId,
          graphId,
          content,
          sourceId,
          sourceName,
          context: typeof item.context === 'string' ? item.context : content,
          startChar: typeof item.startChar === 'number' ? item.startChar : 0,
          endChar:
            typeof item.endChar === 'number' ? item.endChar : content.length,
          pageNum: typeof item.pageNum === 'number' ? item.pageNum : 1,
          coordinates: Array.isArray(item.coordinates)
            ? (item.coordinates as number[])
            : undefined,
          elementType:
            typeof item.elementType === 'string' ? item.elementType : undefined,
          imageAssetUrl:
            typeof item.imageAssetUrl === 'string'
              ? item.imageAssetUrl
              : undefined,
          lqip: typeof item.lqip === 'string' ? item.lqip : undefined,
          score: Number.parseFloat(additional?.score ?? '0'),
          ...(vector?.length ? { vector } : {}),
        },
      ];
    });
  }

  private buildNodeFilter(nodeIds: string[]): string {
    if (nodeIds.length === 1) {
      return `{ path: ["nodeId"], operator: Equal, valueText: ${JSON.stringify(nodeIds[0])} }`;
    }
    return `{ path: ["nodeId"], operator: ContainsAny, valueText: ${JSON.stringify(nodeIds)} }`;
  }

  private async ensureSchema(): Promise<void> {
    const schema = await this.request('/v1/schema/Chunk');
    if (schema.ok) {
      const body = (await schema.json()) as {
        properties?: Array<{ name?: string }>;
      };
      const existing = new Set(body.properties?.map((prop) => prop.name));
      if (!existing.has('pageNum')) {
        await this.addProperty('pageNum', ['int']);
      }
      if (!existing.has('coordinates')) {
        await this.addProperty('coordinates', ['number[]']);
      }
      if (!existing.has('elementType')) {
        await this.addProperty('elementType', ['text']);
      }
      if (!existing.has('imageAssetUrl')) {
        await this.addProperty('imageAssetUrl', ['text']);
      }
      if (!existing.has('lqip')) {
        await this.addProperty('lqip', ['text']);
      }
      return;
    }
    const response = await this.request('/v1/schema', {
      method: 'POST',
      body: JSON.stringify({
        class: 'Chunk',
        vectorizer: 'none',
        vectorIndexConfig: {
          distance: 'cosine',
          pq: {
            enabled: this.pqEnabled,
            trainingLimit: this.pqTrainingLimit,
            segments: this.pqSegments,
          },
        },
        multiTenancyConfig: {
          enabled: true,
          autoTenantCreation: true,
          autoTenantActivation: true,
        },
        properties: [
          { name: 'sourceId', dataType: ['text'], tokenization: 'field' },
          { name: 'graphId', dataType: ['text'], tokenization: 'field' },
          { name: 'sourceName', dataType: ['text'] },
          { name: 'nodeId', dataType: ['text'], tokenization: 'field' },
          { name: 'content', dataType: ['text'] },
          { name: 'context', dataType: ['text'] },
          { name: 'startChar', dataType: ['int'] },
          { name: 'endChar', dataType: ['int'] },
          { name: 'pageNum', dataType: ['int'] },
          { name: 'coordinates', dataType: ['number[]'] },
          { name: 'elementType', dataType: ['text'] },
          { name: 'imageAssetUrl', dataType: ['text'] },
          { name: 'lqip', dataType: ['text'] },
        ],
      }),
    });
    if (!response.ok && response.status !== 422) {
      throw new Error(`Weaviate schema setup failed: ${response.status}`);
    }
  }

  private async addProperty(name: string, dataType: string[]): Promise<void> {
    const response = await this.request('/v1/schema/Chunk/properties', {
      method: 'POST',
      body: JSON.stringify({ name, dataType }),
    });
    if (!response.ok && response.status !== 422) {
      throw new Error(`Weaviate schema update failed: ${response.status}`);
    }
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...init?.headers },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function withoutVector(chunk: VectorizedSearchChunk): SearchChunk {
  const copy = { ...chunk };
  delete copy.vector;
  return copy;
}
