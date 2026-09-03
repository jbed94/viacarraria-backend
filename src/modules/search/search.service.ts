import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

import { DatabaseService } from '../../common/services/database.service.js';
import { AuthorizationService } from '../../common/authorization/ability.js';
import { EmbeddingService } from '../../common/services/embedding.service.js';
import { WeaviateService } from '../../common/services/weaviate.service.js';
import type { SearchChunk, ViewerIdentity } from '../../common/types.js';
import { AuthService } from '../auth/auth.service.js';
import { GraphsService } from '../graphs/graphs.service.js';
import type { SearchDto, UpdateQueryDto } from './search.dto.js';

type DatabaseChunk = {
  id: string;
  nodeId: string;
  name: string;
  content: string;
};

type RetrievedChunk = {
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
};

@Injectable()
export class SearchService {
  constructor(
    private readonly database: DatabaseService,
    private readonly embeddings: EmbeddingService,
    private readonly weaviate: WeaviateService,
    private readonly graphs: GraphsService,
    private readonly auth: AuthService,
    private readonly authorization: AuthorizationService,
  ) {}

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
    const retrieved = await this.retrieve(graph.id, queryText, selectedNodeIds);
    const chunks = await this.extendMatches(
      graph.id,
      graph.edges,
      retrieved,
      Boolean(dto.extendedSearch),
      viewer.tier === 'PRO' ? 15 : 3,
    );
    const results = groupChunks(chunks);
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

  private async retrieve(
    graphId: string,
    query: string,
    nodeIds: string[],
  ): Promise<RetrievedChunk[]> {
    try {
      const vector = await this.embeddings.embed(query);
      if (vector) {
        const indexed = await this.weaviate.hybridSearch(
          graphId,
          query,
          nodeIds,
          vector,
        );
        if (indexed.length > 0) {
          return indexed.map(({ vector, ...chunk }) => ({ chunk, vector }));
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
    return sources
      .map((source) => ({
        graphId,
        sourceId: source.id,
        sourceName: source.name,
        nodeId: source.nodeId,
        content: source.content,
        context: source.content,
        startChar: 0,
        endChar: source.content.length,
        pageNum: 1,
        score: lexicalScore(source.content, query),
      }))
      .filter((source) => source.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((chunk) => ({ chunk }));
  }

  private async extendMatches(
    graphId: string,
    edges: Array<{ source: string; target: string }>,
    retrieved: RetrievedChunk[],
    enabled: boolean,
    budget: number,
  ): Promise<SearchChunk[]> {
    const directChunks = retrieved.map(({ chunk }) => ({
      ...chunk,
      kind: 'MATCH' as const,
    }));
    if (!enabled || directChunks.length === 0) return directChunks;

    let remaining = budget;
    for (const [index, directChunk] of directChunks.entries()) {
      if (remaining === 0) break;
      const adjacentNodeIds = adjacentNodes(directChunk.nodeId, edges);
      if (adjacentNodeIds.length === 0) continue;
      const vector =
        retrieved[index]?.vector ??
        (await this.embeddings.embed(directChunk.content));
      if (!vector) continue;
      try {
        const extendedContext = await this.weaviate.vectorSearch(
          graphId,
          vector,
          adjacentNodeIds,
          Math.min(remaining, 3),
        );
        directChunk.extendedContext = extendedContext.map((chunk) => ({
          ...chunk,
          kind: 'EXTENDED',
        }));
        remaining -= directChunk.extendedContext.length;
      } catch {
        // Extended context is optional; direct search results remain valid.
      }
    }
    return directChunks;
  }
}

function adjacentNodes(
  nodeId: string,
  edges: Array<{ source: string; target: string }>,
): string[] {
  return [
    ...new Set(
      edges.flatMap((edge) =>
        edge.source === nodeId
          ? [edge.target]
          : edge.target === nodeId
            ? [edge.source]
            : [],
      ),
    ),
  ];
}

function lexicalScore(content: string, query: string): number {
  const haystack = content.toLowerCase();
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1)
    .reduce((score, term) => score + occurrences(haystack, term), 0);
}

function occurrences(content: string, term: string): number {
  return content.split(term).length - 1;
}

function groupChunks(chunks: SearchChunk[]): SearchResponse['results'] {
  const byNode = new Map<string, SearchChunk[]>();
  for (const chunk of chunks) {
    const items = byNode.get(chunk.nodeId) ?? [];
    if (items.length < 5) {
      items.push(chunk);
    }
    byNode.set(chunk.nodeId, items);
  }
  return [...byNode.entries()]
    .map(([nodeId, items]) => ({
      nodeId,
      matchCount: items.length,
      chunks: items,
    }))
    .sort((left, right) => right.chunks[0]!.score - left.chunks[0]!.score);
}
