import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

import { DatabaseService } from '../../common/services/database.service.js';
import { AuthorizationService } from '../../common/authorization/ability.js';
import { EmbeddingService } from '../../common/services/embedding.service.js';
import { WeaviateService } from '../../common/services/weaviate.service.js';
import type { SearchChunk, ViewerIdentity } from '../../common/types.js';
import { AuthService } from '../auth/auth.service.js';
import { GraphsService } from '../graphs/graphs.service.js';
import type {
  SearchDto,
  SearchScope,
  SearchSensitivity,
  UpdateQueryDto,
} from './search.dto.js';
import {
  adjacentNodes,
  applyTabularBoosting,
  chunkText,
  groupChunks,
  isTableChunk,
  isTabularQuery,
  lexicalScore,
  type DatabaseChunk,
} from './search.utils.js';

export type RetrievedChunk = {
  chunk: SearchChunk;
  vector?: number[];
};

type QueryRecord = {
  id: string;
  graphId: string;
  queryText: string;
  selectedNodeIds: string[];
  results: SearchResponse['results'] | null;
  title: string | null;
  isPinned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type SearchResponse = {
  queryId: string;
  results: Array<{ nodeId: string; matchCount: number; chunks: SearchChunk[] }>;
  matchedNodeIds: string[];
  remaining: number;
  extendedSearch: boolean;
  extendedContextCount: number;
  sensitivity?: SearchSensitivity;
  scope?: SearchScope;
};

@Injectable()
export class SearchService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly embeddings: EmbeddingService,
    private readonly weaviate: WeaviateService,
    private readonly graphs: GraphsService,
    private readonly auth: AuthService,
    private readonly authorization: AuthorizationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const ready = await this.weaviate.isReady();
      if (!ready) {
        return;
      }

      const systemGraphs = await this.database.query<{ id: string }>(
        `SELECT "id" FROM "Graph" WHERE "id" LIKE 'system-%' OR "slug" IN ('medicine', 'computer-science', 'finance')`,
      );

      for (const graph of systemGraphs) {
        try {
          const result = await this.indexGraphSources(graph.id);
          if (result.indexedChunks > 0) {
            this.logger.log(
              `Auto-warmed Weaviate vector index for ${graph.id}: ${result.indexedChunks} chunks`,
            );
          }
        } catch (error: unknown) {
          this.logger.warn(
            `Failed to auto-warm Weaviate for graph ${graph.id}: ${String(error)}`,
          );
        }
      }
    } catch {
      // Non-blocking: background warmup should not fail startup
    }
  }

  async search(
    identity: ViewerIdentity | undefined,
    dto: SearchDto,
  ): Promise<SearchResponse> {
    const viewer = this.auth.requireIdentity(identity);
    const graph = await this.graphs.findAccessible(viewer, dto.graphId);
    this.authorization.assertCan(viewer, 'query', 'Graph', graph);
    const availableNodeIds = new Set(graph.nodes.map((node) => node.id));
    const selectedNodeIds = [
      ...new Set(
        dto.selectedNodeIds?.length
          ? dto.selectedNodeIds
          : [...availableNodeIds],
      ),
    ];
    if (
      selectedNodeIds.length === 0 ||
      selectedNodeIds.some((nodeId) => !availableNodeIds.has(nodeId))
    ) {
      throw new BadRequestException(
        'Select one or more nodes from the active graph.',
      );
    }
    const maximum =
      viewer.tier === 'ANONYMOUS'
        ? 2
        : viewer.tier === 'FREE'
          ? 10
          : Number.POSITIVE_INFINITY;
    if (selectedNodeIds.length > maximum) {
      throw new ForbiddenException(
        `Your plan supports up to ${maximum} selected nodes per query.`,
      );
    }
    if (dto.extendedSearch && viewer.isGuest) {
      throw new ForbiddenException(
        'Extended search is available to registered accounts.',
      );
    }
    const quota = await this.auth.consumeQueryQuota(viewer);
    const queryText = dto.query.trim();
    const sensitivity = dto.sensitivity ?? 'medium';
    const scope = dto.scope ?? 'normal';

    const retrieved = await this.retrieve(
      graph.id,
      queryText,
      selectedNodeIds,
      sensitivity,
      scope,
    );
    const chunks = await this.extendMatches(
      graph.id,
      graph.edges,
      retrieved,
      Boolean(dto.extendedSearch),
      viewer.tier === 'PRO' ? 15 : 3,
      queryText,
      sensitivity,
    );
    const results = groupChunks(chunks, scope);
    const [stored] = await this.database.query<{ id: string }>(
      `INSERT INTO "Query" ("id", "userId", "graphId", "queryText", "selectedNodeIds", "results", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, CURRENT_TIMESTAMP)
       RETURNING "id"`,
      [
        randomUUID(),
        viewer.userId,
        graph.id,
        queryText,
        JSON.stringify(selectedNodeIds),
        JSON.stringify(results),
      ],
    );
    if (!stored) {
      throw new NotFoundException('Query could not be recorded.');
    }
    return {
      queryId: stored.id,
      results,
      matchedNodeIds: results.map((result) => result.nodeId),
      remaining: quota.remaining,
      extendedSearch: Boolean(dto.extendedSearch),
      extendedContextCount: chunks.reduce(
        (count, chunk) => count + (chunk.extendedContext?.length ?? 0),
        0,
      ),
      sensitivity,
      scope,
    };
  }

  async get(
    identity: ViewerIdentity | undefined,
    queryId: string,
  ): Promise<QueryRecord> {
    const viewer = this.auth.requireIdentity(identity);
    const query = await this.database.one<QueryRecord>(
      `SELECT "id", "graphId", "queryText", "selectedNodeIds", "results", "title", "isPinned", "createdAt", "updatedAt"
       FROM "Query" WHERE "id" = $1 AND "userId" = $2`,
      [queryId, viewer.userId],
    );
    if (!query) {
      throw new NotFoundException('Query not found.');
    }
    return query;
  }

  async history(identity: ViewerIdentity | undefined): Promise<QueryRecord[]> {
    const viewer = this.auth.requireIdentity(identity);
    return this.database.query<QueryRecord>(
      `SELECT "id", "graphId", "queryText", "selectedNodeIds", "results", "title", "isPinned", "createdAt", "updatedAt"
       FROM "Query" WHERE "userId" = $1 ORDER BY "isPinned" DESC, "createdAt" DESC LIMIT 50`,
      [viewer.userId],
    );
  }

  async update(
    identity: ViewerIdentity | undefined,
    queryId: string,
    dto: UpdateQueryDto,
  ): Promise<QueryRecord> {
    const viewer = this.auth.requireIdentity(identity);
    const [query] = await this.database.query<QueryRecord>(
      `UPDATE "Query"
       SET "title" = COALESCE($1, "title"), "isPinned" = COALESCE($2, "isPinned"), "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $3 AND "userId" = $4
       RETURNING "id", "graphId", "queryText", "selectedNodeIds", "results", "title", "isPinned", "createdAt", "updatedAt"`,
      [dto.title?.trim() || null, dto.isPinned ?? null, queryId, viewer.userId],
    );
    if (!query) {
      throw new NotFoundException('Query not found.');
    }
    return query;
  }

  async indexGraph(
    identity: ViewerIdentity | undefined,
    graphId: string,
  ): Promise<{ indexedChunks: number; sourceCount: number }> {
    const viewer = this.auth.requireIdentity(identity);
    const graph = await this.graphs.findAccessible(viewer, graphId);
    this.authorization.assertCan(viewer, 'update', 'Graph', graph);

    return this.indexGraphSources(graph.id);
  }

  async indexGraphSources(
    graphId: string,
  ): Promise<{ indexedChunks: number; sourceCount: number }> {
    const sources = await this.database.query<DatabaseChunk>(
      `SELECT "id", "nodeId", "name", "content" FROM "NodeSource"
       WHERE "graphId" = $1 AND "content" IS NOT NULL AND "status" = 'READY'`,
      [graphId],
    );

    if (sources.length === 0) {
      return { indexedChunks: 0, sourceCount: 0 };
    }

    const allChunks = sources.flatMap((source) => chunkText(source, graphId));
    if (allChunks.length === 0) {
      return { indexedChunks: 0, sourceCount: sources.length };
    }

    const vectors = await Promise.all(
      allChunks.map(async (chunk) => {
        try {
          return await this.embeddings.embed(chunk.content);
        } catch {
          return undefined;
        }
      }),
    );

    const indexedChunks = await this.weaviate.upsertBatch(allChunks, vectors);
    return { indexedChunks, sourceCount: sources.length };
  }

  private async retrieve(
    graphId: string,
    query: string,
    nodeIds: string[],
    sensitivity: SearchSensitivity = 'medium',
    scope: SearchScope = 'normal',
  ): Promise<RetrievedChunk[]> {
    const vectorThreshold =
      sensitivity === 'high' ? 0.55 : sensitivity === 'low' ? 0.1 : 0.28;
    const matchLimit = scope === 'narrow' ? 6 : scope === 'wide' ? 24 : 12;

    try {
      const vector = await this.embeddings.embed(query);
      if (vector) {
        const indexed = await this.weaviate.hybridSearch(
          graphId,
          query,
          nodeIds,
          vector,
          matchLimit,
          vectorThreshold,
        );
        if (indexed.length > 0) {
          const raw = indexed.map(({ vector, ...chunk }) => ({
            chunk,
            vector,
          }));
          return applyTabularBoosting(raw, query).slice(0, matchLimit);
        }
      }
    } catch {
      // Seeded and development content remains searchable before indexing completes.
    }

    const sources = await this.database.query<DatabaseChunk>(
      `SELECT "id", "nodeId", "name", "content" FROM "NodeSource"
       WHERE "graphId" = $1 AND "nodeId" = ANY($2::text[]) AND "content" IS NOT NULL AND "status" = 'READY'`,
      [graphId, nodeIds],
    );

    const queryTerms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 1);

    const minLexScore =
      sensitivity === 'high'
        ? 3
        : sensitivity === 'low'
          ? 1
          : queryTerms.length <= 1
            ? 1
            : 2;

    const allChunks = sources.flatMap((source) => chunkText(source, graphId));

    return allChunks
      .map((chunk) => {
        const baseScore = lexicalScore(chunk.content, query);
        const tableBonus = isTabularQuery(query) && isTableChunk(chunk) ? 3 : 0;
        return {
          chunk: {
            ...chunk,
            score: baseScore + tableBonus,
          },
        };
      })
      .filter(({ chunk }) => chunk.score >= minLexScore)
      .sort((left, right) => right.chunk.score - left.chunk.score)
      .slice(0, matchLimit);
  }

  async extendMatches(
    graphId: string,
    edges: Array<{ source: string; target: string }>,
    retrieved: RetrievedChunk[],
    enabled: boolean,
    budget: number,
    queryText: string,
    sensitivity: SearchSensitivity = 'medium',
  ): Promise<SearchChunk[]> {
    const directChunks = retrieved.map(({ chunk }) => ({
      ...chunk,
      kind: 'MATCH' as const,
    }));
    if (!enabled || directChunks.length === 0) return directChunks;

    const perMatchLimit = Math.max(
      1,
      Math.min(3, Math.ceil(budget / directChunks.length)),
    );

    for (const [index, directChunk] of directChunks.entries()) {
      const adjacentNodeIds = adjacentNodes(directChunk.nodeId, edges).filter(
        (id) => id !== directChunk.nodeId,
      );
      const targetNodeIds = [
        ...new Set([directChunk.nodeId, ...adjacentNodeIds]),
      ];
      if (targetNodeIds.length === 0) continue;

      const isSameExactChunk = (c: SearchChunk) =>
        c.sourceId === directChunk.sourceId &&
        c.startChar === directChunk.startChar &&
        c.endChar === directChunk.endChar;

      let extendedResults: SearchChunk[] = [];

      // 1. Try vector search via Weaviate (same source + adjacent nodes)
      const vector =
        retrieved[index]?.vector ??
        (await this.embeddings.embed(directChunk.content));
      if (vector) {
        try {
          const vectorMatches = await this.weaviate.vectorSearch(
            graphId,
            vector,
            targetNodeIds,
            perMatchLimit + 1,
            sensitivity === 'high' ? 0.5 : sensitivity === 'low' ? 0.1 : 0.25,
          );
          if (vectorMatches.length > 0) {
            extendedResults = vectorMatches
              .filter((c) => !isSameExactChunk(c))
              .slice(0, perMatchLimit);
          }
        } catch {
          // Fall back to database search
        }
      }

      // 2. Robust Fallback: Search the same source AND adjacent nodes' sources in PostgreSQL
      if (extendedResults.length === 0) {
        const candidateSources = await this.database.query<DatabaseChunk>(
          `SELECT "id", "nodeId", "name", "content" FROM "NodeSource"
           WHERE "graphId" = $1 AND ("id" = $2 OR "nodeId" = ANY($3::text[])) AND "content" IS NOT NULL AND "status" = 'READY'`,
          [graphId, directChunk.sourceId, adjacentNodeIds],
        );

        const candidateChunks = candidateSources.flatMap((source) =>
          chunkText(source, graphId),
        );

        const minScore = sensitivity === 'high' ? 2 : 1;
        const scored = candidateChunks
          .filter((chunk) => !isSameExactChunk(chunk))
          .map((chunk) => {
            const queryScore = lexicalScore(chunk.content, queryText);
            const contextScore = lexicalScore(
              chunk.content,
              directChunk.content,
            );
            const sameSourceBonus =
              chunk.sourceId === directChunk.sourceId ? 1 : 0;
            return {
              ...chunk,
              score: queryScore * 2 + contextScore + sameSourceBonus,
            };
          })
          .filter((chunk) => chunk.score >= minScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, perMatchLimit);

        extendedResults = scored;
      }

      if (extendedResults.length > 0) {
        directChunk.extendedContext = extendedResults.map((chunk) => ({
          ...chunk,
          kind: 'EXTENDED' as const,
        }));
      }
    }
    return directChunks;
  }
}
