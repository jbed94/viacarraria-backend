import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import {
  extractGraphVocabulary,
  extractVocabularyFromSource,
  generateContextualSuggestions,
  mergeVocabularyItems,
  type GraphVocabularyItem,
  type SearchSuggestionsResult,
} from './vocabulary.utils.js';

import { DatabaseService } from '../../common/services/database.service.js';
import { AuthorizationService } from '../../common/authorization/ability.js';
import { EmbeddingService } from '../../common/services/embedding.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import { RerankService } from '../../common/services/rerank.service.js';
import {
  WeaviateService,
  type VectorSearchQuery,
  type VectorizedSearchChunk,
} from '../../common/services/weaviate.service.js';
import type {
  LeadAnswer,
  SearchChunk,
  SubscriptionTier,
  ViewerIdentity,
} from '../../common/types.js';
import { AuthService } from '../auth/auth.service.js';
import { GraphsService } from '../graphs/graphs.service.js';
import type {
  CancelCrawlResponse,
  ComparativeGroupSummary,
  CrawlDepth,
  CrawlDirection,
  CrawlDto,
  CrawlEdge,
  CrawlMatchType,
  CrawlNode,
  CrawlResponse,
  CrawlSummaryStats,
  SearchDto,
  SearchScope,
  SearchSensitivity,
  UpdateQueryDto,
} from './search.dto.js';
import {
  adjacentNodes,
  applyTabularBoosting,
  chunkText,
  classifyCrawlCandidate,
  computeBranchEntropy,
  computeCentroid,
  computeGraphDepthMetrics,
  computeGraphEntropy,
  connectedNodes,
  cosineSimilarity,
  determineAdaptiveMaxBranchEntropy,
  determineAnswerType,
  expandQueryKeywords,
  extractSharedKeywords,
  groupChunks,
  isTableChunk,
  isTabularQuery,
  lexicalScore,
  pruneAndDeduplicateBranches,
  selectDiverseBranches,
  selectDiverseCandidatesMmr,
  type ClassifiedCandidateItem,
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
  results: unknown;
  title: string | null;
  isPinned: boolean;
  creditsCost?: number;
  createdAt: Date;
  updatedAt: Date;
};

export type SearchResponse = {
  queryId: string;
  queryType?: 'simple' | 'crawl';
  query?: string;
  expandedKeywords?: string[];
  leadAnswer?: LeadAnswer;
  results: Array<{ nodeId: string; matchCount: number; chunks: SearchChunk[] }>;
  matchedNodeIds: string[];
  remaining: number;
  creditsCost?: number;
  searchSpaceMultiplier?: number;
  sensitivity?: SearchSensitivity;
  scope?: SearchScope;
};

@Injectable()
export class SearchService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SearchService.name);
  private inMemorySynonyms: Record<string, string[]> | null = null;
  private settingsSubscriber: ReturnType<
    RedisService['createSubscriber']
  > | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly embeddings: EmbeddingService,
    private readonly rerank: RerankService,
    private readonly weaviate: WeaviateService,
    private readonly graphs: GraphsService,
    private readonly auth: AuthService,
    private readonly authorization: AuthorizationService,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  private readonly activeCrawlControllers = new Map<string, AbortController>();

  private readonly inMemoryTopologyCache = new Map<
    string,
    {
      metrics: import('./search.utils.js').GraphDepthMetrics;
      expiresAt: number;
    }
  >();

  setInMemorySynonyms(synonyms: Record<string, string[]> | null): void {
    this.inMemorySynonyms = synonyms;
  }

  async cancelCrawl(
    identity: ViewerIdentity | undefined,
    jobId: string,
  ): Promise<CancelCrawlResponse> {
    const viewer = this.auth.requireIdentity(identity);
    this.logger.log(`Cancelling crawl job ${jobId} by user ${viewer.userId}`);
    const controller = this.activeCrawlControllers.get(jobId);
    if (controller) {
      controller.abort();
      this.activeCrawlControllers.delete(jobId);
    }
    if (this.redisService) {
      await this.redisService.set(`crawl:cancel:${jobId}`, '1', 120);
    }
    return {
      jobId,
      cancelled: true,
      message: `Crawl job ${jobId} cancellation requested.`,
    };
  }

  async getActiveSynonyms(): Promise<Record<string, string[]>> {
    if (this.inMemorySynonyms) {
      return this.inMemorySynonyms;
    }
    if (this.redisService) {
      try {
        const raw = await this.redisService.get('system:settings');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (
            parsed.synonymsConfig &&
            typeof parsed.synonymsConfig === 'object'
          ) {
            this.inMemorySynonyms = parsed.synonymsConfig;
            return parsed.synonymsConfig;
          }
        }
      } catch {
        // Fall back to database query
      }
    }
    try {
      const rows = await this.database.query<{
        value: Record<string, string[]>;
      }>(`SELECT "value" FROM "SystemSettings" WHERE "key" = 'synonymsConfig'`);
      if (rows[0]?.value && typeof rows[0].value === 'object') {
        this.inMemorySynonyms = rows[0].value;
        return rows[0].value;
      }
    } catch {
      // Table may not have the row yet
    }
    this.inMemorySynonyms = {};
    return {};
  }

  async getCachedGraphDepthMetrics(
    graphId: string,
    graphUpdatedAt: Date | string,
    nodes: any[],
    edges: any[],
    startingNodeIds: string[],
    direction: CrawlDirection,
  ): Promise<import('./search.utils.js').GraphDepthMetrics> {
    const sortedSeeds = startingNodeIds.slice().sort().join(',');
    const seedHash = createHash('sha256')
      .update(sortedSeeds)
      .digest('hex')
      .slice(0, 16);
    const updatedTimestamp = new Date(graphUpdatedAt).getTime();
    const cacheKey = `crawl:topology:${graphId}:${updatedTimestamp}:${direction}:${seedHash}`;

    if (this.redisService) {
      try {
        const cached = await this.redisService.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      } catch (err) {
        this.logger.warn(`Redis topology cache get error: ${err}`);
      }
    }

    const now = Date.now();
    const memCached = this.inMemoryTopologyCache.get(cacheKey);
    if (memCached && memCached.expiresAt > now) {
      this.inMemoryTopologyCache.delete(cacheKey);
      this.inMemoryTopologyCache.set(cacheKey, memCached);
      return memCached.metrics;
    }

    const metrics = computeGraphDepthMetrics(
      nodes,
      edges,
      startingNodeIds,
      direction,
    );

    if (this.inMemoryTopologyCache.size >= 500) {
      const oldestKey = this.inMemoryTopologyCache.keys().next().value;
      if (oldestKey) this.inMemoryTopologyCache.delete(oldestKey);
    }
    this.inMemoryTopologyCache.set(cacheKey, {
      metrics,
      expiresAt: now + 3600 * 1000,
    });

    if (this.redisService) {
      try {
        await this.redisService.set(cacheKey, JSON.stringify(metrics), 3600);
      } catch (err) {
        this.logger.warn(`Redis topology cache set error: ${err}`);
      }
    }

    return metrics;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.initPubSubSubscriber();
    try {
      const ready = await this.weaviate.isReady();
      if (!ready) {
        return;
      }

      const systemGraphs = await this.database.query<{ id: string }>(
        `SELECT "id" FROM "Graph" WHERE "id" LIKE 'system-%'`,
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
    } catch (error: unknown) {
      this.logger.warn(
        `Background Weaviate warmup encountered an error: ${String(error)}`,
      );
    }
  }

  async initPubSubSubscriber(): Promise<void> {
    if (!this.redisService) return;
    try {
      this.settingsSubscriber = this.redisService.createSubscriber();
      if (this.settingsSubscriber) {
        this.settingsSubscriber.on('error', (err: Error) => {
          this.logger.warn(`Settings subscriber error: ${err.message}`);
        });
        await this.settingsSubscriber.connect().catch((err: unknown) => {
          this.logger.warn(`Settings subscriber connect error: ${String(err)}`);
        });
        await this.settingsSubscriber
          .subscribe('system:settings:updated')
          .catch((err: unknown) => {
            this.logger.warn(
              `Settings subscriber subscribe error: ${String(err)}`,
            );
          });
        this.settingsSubscriber.on(
          'message',
          (channel: string, message: string) => {
            if (channel === 'system:settings:updated') {
              try {
                const data = JSON.parse(message);
                if (data?.settings?.synonymsConfig) {
                  this.inMemorySynonyms = data.settings.synonymsConfig;
                  this.logger.debug(
                    'Refreshed in-memory synonyms from Redis pub/sub',
                  );
                } else if (data?.synonymsConfig) {
                  this.inMemorySynonyms = data.synonymsConfig;
                  this.logger.debug(
                    'Refreshed in-memory synonyms from Redis pub/sub',
                  );
                }
              } catch (err) {
                this.logger.warn(
                  `Failed to parse settings update pub/sub message: ${err}`,
                );
              }
            }
          },
        );
      }
    } catch (err) {
      this.logger.warn(`Failed to initialize settings subscriber: ${err}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.settingsSubscriber) {
      try {
        await this.settingsSubscriber.quit();
      } catch {
        // ignore
      }
      this.settingsSubscriber = null;
    }
  }

  async getGraphVocabulary(
    graphId: string,
    nodeIds?: string[],
  ): Promise<GraphVocabularyItem[]> {
    const hasNodeFilter = Array.isArray(nodeIds) && nodeIds.length > 0;
    const sortedNodeIds = hasNodeFilter ? [...new Set(nodeIds)].sort() : [];
    const cacheKey = hasNodeFilter
      ? `graph:${graphId}:nodes:${sortedNodeIds.join(',')}:vocabulary`
      : `graph:${graphId}:vocabulary`;

    if (this.redisService) {
      try {
        const cached = await this.redisService.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        }
      } catch (err) {
        this.logger.warn(`Failed reading vocabulary from Redis: ${err}`);
      }
    }

    const [graphRow] = await this.database.query<{ nodes: any[] }>(
      `SELECT "nodes" FROM "Graph" WHERE "id" = $1`,
      [graphId],
    );

    const sources = hasNodeFilter
      ? await this.database.query<{
          id: string;
          nodeId: string;
          content: string | null;
          name: string;
        }>(
          `SELECT "id", "nodeId", "content", "name" FROM "NodeSource" WHERE "graphId" = $1 AND "status" = 'READY' AND "content" IS NOT NULL AND "nodeId" = ANY($2)`,
          [graphId, sortedNodeIds],
        )
      : await this.database.query<{
          id: string;
          nodeId: string;
          content: string | null;
          name: string;
        }>(
          `SELECT "id", "nodeId", "content", "name" FROM "NodeSource" WHERE "graphId" = $1 AND "status" = 'READY' AND "content" IS NOT NULL`,
          [graphId],
        );

    const rawNodes = Array.isArray(graphRow?.nodes) ? graphRow.nodes : [];
    const nodes = hasNodeFilter
      ? rawNodes.filter((n: any) => sortedNodeIds.includes(n.id))
      : rawNodes;

    const sourceItemsList: GraphVocabularyItem[][] = [];
    const sourceKeys = sources.map((s) => `source:${s.id}:vocabulary`);
    let cachedSourceResults: (string | null)[] = [];

    if (this.redisService && sourceKeys.length > 0) {
      try {
        cachedSourceResults = await this.redisService.mget(sourceKeys);
      } catch (err) {
        this.logger.warn(
          `Failed reading source vocabularies via mget from Redis: ${err}`,
        );
      }
    }

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]!;
      let items: GraphVocabularyItem[] | null = null;
      const cachedSource = cachedSourceResults[i];

      if (cachedSource) {
        try {
          const parsed = JSON.parse(cachedSource);
          if (Array.isArray(parsed)) {
            items = parsed;
          }
        } catch {
          // If JSON parse fails, fall back to extractVocabularyFromSource
        }
      }

      if (!items) {
        items = extractVocabularyFromSource(source);
        if (this.redisService && source.id && items.length > 0) {
          void this.redisService
            .set(
              `source:${source.id}:vocabulary`,
              JSON.stringify(items),
              86400 * 7,
            )
            .catch(() => {});
        }
      }
      sourceItemsList.push(items);
    }

    const vocabulary = mergeVocabularyItems(nodes, sourceItemsList);

    if (this.redisService) {
      try {
        await this.redisService.set(
          cacheKey,
          JSON.stringify(vocabulary),
          86400 * 7,
        );
      } catch (err) {
        this.logger.warn(`Failed caching vocabulary in Redis: ${err}`);
      }
    }

    return vocabulary;
  }

  async getVocabulary(
    identity: ViewerIdentity | undefined,
    graphId: string,
    nodeIds: string[] = [],
  ): Promise<GraphVocabularyItem[]> {
    const viewer = this.auth.requireIdentity(identity);
    const graph = await this.graphs.findAccessible(viewer, graphId);
    this.authorization.assertCan(viewer, 'query', 'Graph', graph);

    return this.getGraphVocabulary(graphId, nodeIds);
  }

  async invalidateGraphVocabulary(graphId: string): Promise<void> {
    if (this.redisService) {
      try {
        await this.redisService.del(`graph:${graphId}:vocabulary`);
      } catch (err) {
        this.logger.warn(`Failed invalidating graph vocabulary cache: ${err}`);
      }
    }
  }

  async getSuggestions(
    identity: ViewerIdentity | undefined,
    graphId: string,
    selectedNodeIds: string[] = [],
    queryPrefix = '',
    limit = 8,
  ): Promise<SearchSuggestionsResult> {
    const viewer = this.auth.requireIdentity(identity);
    const graph = await this.graphs.findAccessible(viewer, graphId);
    this.authorization.assertCan(viewer, 'query', 'Graph', graph);

    const [vocabulary, activeSynonyms] = await Promise.all([
      this.getGraphVocabulary(graphId),
      this.getActiveSynonyms(),
    ]);

    const nodes = Array.isArray(graph.nodes) ? (graph.nodes as any[]) : [];

    return generateContextualSuggestions({
      vocabulary,
      nodes,
      selectedNodeIds,
      queryPrefix,
      activeSynonyms,
      limit,
    });
  }

  async search(
    identity: ViewerIdentity | undefined,
    dto: SearchDto,
  ): Promise<SearchResponse> {
    const viewer = this.auth.requireIdentity(identity);
    const graph = await this.graphs.findAccessible(viewer, dto.graphId);
    this.authorization.assertCan(viewer, 'query', 'Graph', graph);
    if (!graph.isPrepared && graph.userId !== viewer.userId) {
      const isAttached = await this.graphs.isAttached(viewer.userId, graph.id);
      if (!isAttached) {
        throw new ForbiddenException(
          'Please attach to this graph to enable querying.',
        );
      }
    }
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
    const maximum = viewer.tier === 'ANONYMOUS' ? 2 : Number.POSITIVE_INFINITY;
    if (selectedNodeIds.length > maximum) {
      throw new ForbiddenException(
        'Guest searches support up to 2 selected topics. Register for free to select unlimited topics.',
      );
    }
    const quota = await this.auth.consumeQueryQuota(viewer, {
      selectedNodeCount: selectedNodeIds.length,
      isCrawl: false,
    });
    const queryText = (dto.query ?? '').trim();
    if (!queryText) {
      throw new BadRequestException('Provide a query text to search.');
    }
    const sensitivity = dto.sensitivity ?? 'medium';
    const scope = dto.scope ?? 'normal';
    const synonyms = await this.getActiveSynonyms();
    const { expandedKeywords } = expandQueryKeywords(queryText, synonyms);

    const retrieved = await this.retrieve(
      graph.id,
      queryText,
      selectedNodeIds,
      sensitivity,
      scope,
      viewer.tier,
      synonyms,
    );

    if (retrieved.length > 0 && queryText) {
      try {
        const rerankResults = await this.rerank.rerank(
          queryText,
          retrieved.map((r) => r.chunk.content),
        );
        if (rerankResults && rerankResults.length > 0) {
          for (const item of rerankResults) {
            const target = retrieved[item.index];
            if (target) {
              target.chunk.rerankScore = item.score;
              target.chunk.score = item.score;
            }
          }
          retrieved.sort(
            (a, b) =>
              (b.chunk.rerankScore ?? b.chunk.score) -
              (a.chunk.rerankScore ?? a.chunk.score),
          );
        }
      } catch {
        // Fall back to initial retrieval ordering if reranker fails
      }
    }

    const chunks = retrieved.map(({ chunk }) => ({
      ...chunk,
      kind: 'MATCH' as const,
    }));
    const results = groupChunks(chunks, scope);

    let leadAnswer: LeadAnswer | undefined = undefined;
    const topChunk = chunks[0];
    if (topChunk) {
      const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
      const prerequisiteNodes = graph.edges
        .filter((edge) => edge.target === topChunk.nodeId)
        .map((edge) => ({
          id: edge.source,
          title: nodeMap.get(edge.source)?.data?.title || edge.source,
        }))
        .filter(
          (node, idx, arr) => arr.findIndex((x) => x.id === node.id) === idx,
        );

      const extensionNodes = graph.edges
        .filter((edge) => edge.source === topChunk.nodeId)
        .map((edge) => ({
          id: edge.target,
          title: nodeMap.get(edge.target)?.data?.title || edge.target,
        }))
        .filter(
          (node, idx, arr) => arr.findIndex((x) => x.id === node.id) === idx,
        );

      leadAnswer = {
        chunk: topChunk,
        score: topChunk.rerankScore ?? topChunk.score,
        answerType: determineAnswerType(topChunk),
        prerequisiteNodes,
        extensionNodes,
      };
    }

    const searchResponse: SearchResponse = {
      queryId: '',
      queryType: 'simple',
      query: queryText,
      expandedKeywords,
      leadAnswer,
      results,
      matchedNodeIds: results.map((result) => result.nodeId),
      remaining: quota.remaining,
      searchSpaceMultiplier: quota.searchSpaceMultiplier ?? 1.0,
      creditsCost: 0,
      sensitivity,
      scope,
    };

    const [stored] = await this.database.query<{ id: string }>(
      `INSERT INTO "Query" ("id", "userId", "graphId", "queryText", "selectedNodeIds", "results", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, CURRENT_TIMESTAMP)
       RETURNING "id"`,
      [
        randomUUID(),
        viewer.userId,
        graph.id,
        queryText || '[Visual Query]',
        JSON.stringify(selectedNodeIds),
        JSON.stringify(searchResponse),
      ],
    );
    if (!stored) {
      throw new NotFoundException('Query could not be recorded.');
    }
    searchResponse.queryId = stored.id;
    return searchResponse;
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
      `SELECT "id", "graphId", "queryText", "selectedNodeIds", "results", "title", "isPinned",
              COALESCE(("results"->>'creditsCost')::float, 0.0) AS "creditsCost",
              "createdAt", "updatedAt"
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
    const hasTitle = dto.title !== undefined;
    const titleVal = hasTitle ? dto.title?.trim() || null : null;
    const hasPinned = dto.isPinned !== undefined;
    const pinnedVal = hasPinned ? (dto.isPinned ?? false) : false;

    const [query] = await this.database.query<QueryRecord>(
      `UPDATE "Query"
       SET "title" = CASE WHEN $1::boolean THEN $2 ELSE "title" END,
           "isPinned" = CASE WHEN $3::boolean THEN $4 ELSE "isPinned" END,
           "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $5 AND "userId" = $6
       RETURNING "id", "graphId", "queryText", "selectedNodeIds", "results", "title", "isPinned",
                 COALESCE(("results"->>'creditsCost')::float, 0.0) AS "creditsCost",
                 "createdAt", "updatedAt"`,
      [hasTitle, titleVal, hasPinned, pinnedVal, queryId, viewer.userId],
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
    _sensitivity: SearchSensitivity = 'medium',
    scope: SearchScope = 'normal',
    tier?: SubscriptionTier,
    customSynonyms?: Record<string, string[]>,
  ): Promise<RetrievedChunk[]> {
    // Threshold set to 5% (0.05) across queries
    const vectorThreshold = 0.05;
    const matchLimit = scope === 'narrow' ? 6 : scope === 'wide' ? 24 : 12;

    let textRetrieved: RetrievedChunk[] = [];

    // 1. Text hybrid search if query is non-empty
    if (query) {
      try {
        const vector = await this.embeddings.embed(query);
        if (vector) {
          const { expandedQuery } = expandQueryKeywords(query, customSynonyms);
          const indexed = await this.weaviate.hybridSearch(
            graphId,
            expandedQuery,
            nodeIds,
            vector,
            matchLimit,
            vectorThreshold,
            tier,
          );
          if (indexed.length > 0) {
            const raw = indexed.map(({ vector, ...chunk }) => ({
              chunk,
              vector,
            }));
            textRetrieved = applyTabularBoosting(raw, query);
          }
        }
      } catch {
        // Seeded and development content remains searchable before indexing completes.
      }
    }

    if (textRetrieved.length > 0) {
      return textRetrieved.slice(0, matchLimit);
    }

    // 4. Fallback to SQL / lexical chunking if query is present
    if (!query) {
      return [];
    }

    const sources = await this.database.query<DatabaseChunk>(
      `SELECT "id", "nodeId", "name", "content" FROM "NodeSource"
       WHERE "graphId" = $1 AND "nodeId" = ANY($2::text[]) AND "content" IS NOT NULL AND "status" = 'READY'`,
      [graphId, nodeIds],
    );

    const minLexScore = 1;

    const allChunks = sources.flatMap((source) => chunkText(source, graphId));
    const { expandedQuery } = expandQueryKeywords(query, customSynonyms);

    return allChunks
      .map((chunk) => {
        const baseScore = lexicalScore(chunk.content, expandedQuery);
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

  async crawl(
    identity: ViewerIdentity | undefined,
    dto: CrawlDto,
  ): Promise<CrawlResponse> {
    const viewer = this.auth.requireIdentity(identity);
    const graph = await this.graphs.findAccessible(viewer, dto.graphId);
    this.authorization.assertCan(viewer, 'query', 'Graph', graph);
    if (!graph.isPrepared && graph.userId !== viewer.userId) {
      const isAttached = await this.graphs.isAttached(viewer.userId, graph.id);
      if (!isAttached) {
        throw new ForbiddenException(
          'Please attach to this graph to enable querying.',
        );
      }
    }

    const availableNodeIds = new Set(graph.nodes.map((node) => node.id));
    let startingNodeIds = [...new Set(dto.startingNodeIds ?? [])];
    if (
      startingNodeIds.length === 0 &&
      dto.hypothesisGroups &&
      dto.hypothesisGroups.length > 0
    ) {
      startingNodeIds = [
        ...new Set(dto.hypothesisGroups.flatMap((g) => g.nodeIds ?? [])),
      ];
    }
    if (dto.groupBStartingNodeIds && dto.groupBStartingNodeIds.length > 0) {
      for (const id of dto.groupBStartingNodeIds) {
        if (!startingNodeIds.includes(id)) {
          startingNodeIds.push(id);
        }
      }
    }

    if (
      startingNodeIds.length === 0 ||
      startingNodeIds.some((nodeId) => !availableNodeIds.has(nodeId))
    ) {
      throw new BadRequestException(
        'Select at least one starting node from the active graph.',
      );
    }

    const crawlDepth: CrawlDepth | undefined = dto.crawlDepth;
    const comparativeMode = Boolean(dto.comparativeMode);

    if (viewer.tier === 'ANONYMOUS' || viewer.isGuest) {
      if (startingNodeIds.length > 1) {
        throw new ForbiddenException(
          'Anonymous crawl is limited to 1 starting point. Register for free to crawl from multiple starting points.',
        );
      }
      if (crawlDepth && crawlDepth !== 'shallow') {
        throw new ForbiddenException(
          'Anonymous crawl is limited to shallow crawl depth. Register for free to explore deeper knowledge frontiers.',
        );
      }
      if (comparativeMode) {
        throw new ForbiddenException(
          'Comparative hypothesis crawl requires a registered account. Register for free to compare hypotheses.',
        );
      }
    } else if (
      comparativeMode &&
      dto.hypothesisGroups &&
      dto.hypothesisGroups.length > 4
    ) {
      throw new ForbiddenException(
        'Comparative hypothesis crawl supports up to 4 hypothesis groups.',
      );
    }

    if (
      comparativeMode &&
      dto.hypothesisGroups &&
      dto.hypothesisGroups.length > 0
    ) {
      for (const g of dto.hypothesisGroups) {
        if (
          !Array.isArray(g.nodeIds) ||
          g.nodeIds.length === 0 ||
          g.nodeIds.some((nodeId) => !availableNodeIds.has(nodeId))
        ) {
          throw new BadRequestException(
            `Hypothesis group "${g.name || g.id}" contains invalid starting node IDs.`,
          );
        }
      }
    }

    if (
      comparativeMode &&
      dto.groupBStartingNodeIds &&
      dto.groupBStartingNodeIds.length > 0
    ) {
      if (
        dto.groupBStartingNodeIds.some(
          (nodeId) => !availableNodeIds.has(nodeId),
        )
      ) {
        throw new BadRequestException(
          'Group B contains invalid starting node IDs.',
        );
      }
    }

    type NormalizedHypothesisGroup = {
      id: string;
      name: string;
      nodeIds: string[];
      color?: string;
    };

    let normalizedGroups: NormalizedHypothesisGroup[] = [];
    if (comparativeMode) {
      if (dto.hypothesisGroups && dto.hypothesisGroups.length >= 2) {
        const DEFAULT_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b'];
        normalizedGroups = dto.hypothesisGroups.slice(0, 4).map((g, idx) => ({
          id: g.id || `group_${idx + 1}`,
          name: g.name || `Hypothesis ${idx + 1}`,
          nodeIds: [...new Set(g.nodeIds)],
          color: g.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length],
        }));
      } else if (
        dto.groupBStartingNodeIds &&
        dto.groupBStartingNodeIds.length > 0
      ) {
        const groupBIds = [...new Set(dto.groupBStartingNodeIds)];
        const groupAIds = startingNodeIds.filter(
          (id) => !groupBIds.includes(id),
        );
        const finalGroupA = groupAIds.length > 0 ? groupAIds : startingNodeIds;
        normalizedGroups = [
          {
            id: 'groupA',
            name: 'Hypothesis A',
            nodeIds: finalGroupA,
            color: '#3b82f6',
          },
          {
            id: 'groupB',
            name: 'Hypothesis B',
            nodeIds: groupBIds,
            color: '#ef4444',
          },
        ];
      } else if (startingNodeIds.length >= 2) {
        const mid = Math.ceil(startingNodeIds.length / 2);
        const groupA = startingNodeIds.slice(0, mid);
        const groupB = startingNodeIds.slice(mid);
        normalizedGroups = [
          {
            id: 'groupA',
            name: 'Hypothesis A',
            nodeIds: groupA,
            color: '#3b82f6',
          },
          {
            id: 'groupB',
            name: 'Hypothesis B',
            nodeIds: groupB,
            color: '#ef4444',
          },
        ];
      }
    }

    const isComparative = comparativeMode && normalizedGroups.length >= 2;

    const jobId = dto.jobId || randomUUID();
    const abortController = new AbortController();
    this.activeCrawlControllers.set(jobId, abortController);

    try {
      const queryText = (dto.query ?? '').trim();
      if (!queryText) {
        throw new BadRequestException('Provide a query text to crawl.');
      }
      const displayQueryText = queryText;
      const sensitivity = dto.sensitivity ?? 'medium';
      const direction: CrawlDirection = dto.direction ?? 'forward';
      const metrics = await this.getCachedGraphDepthMetrics(
        graph.id,
        graph.updatedAt,
        graph.nodes,
        graph.edges,
        startingNodeIds,
        direction,
      );
      const depthMap: Record<CrawlDepth, number> = {
        shallow: 3,
        default: 6,
        deep: 10,
        unlimited: 15,
      };
      const depthLimit = crawlDepth
        ? (metrics.depthLimits[crawlDepth] ?? depthMap[crawlDepth] ?? 6)
        : 20;
      const maxDepth = dto.maxDepth ?? depthLimit;

      const quota = await this.auth.consumeQueryQuota(viewer, {
        selectedNodeCount: startingNodeIds.length,
        isCrawl: true,
        crawlSteps: maxDepth,
      });

      // Crawl budgets and settings
      const enableDigs =
        dto.enableDigs !== false &&
        (dto.maxDigsPerTopic === undefined || dto.maxDigsPerTopic > 0);
      const maxDigsPerTopic = dto.maxDigsPerTopic ?? 3;
      const enableLinks =
        dto.enableLinks !== false &&
        (dto.maxLinks === undefined || dto.maxLinks > 0);
      const maxLinks = dto.maxLinks ?? 2;
      const enableJumps =
        dto.enableJumps !== false &&
        (dto.maxJumps === undefined || dto.maxJumps > 0);
      const maxJumps = dto.maxJumps ?? 2;
      const minScore = dto.minScore ?? 0.25;
      const maxCandidatesPerStep = dto.maxCandidatesPerStep ?? 3;

      const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
      const vectorCache = new Map<string, number[]>();

      // Initial query embedding
      let v0: number[] = [];
      if (queryText) {
        try {
          v0 = (await this.embeddings.embed(queryText)) ?? [];
        } catch {
          v0 = [];
        }
      }

      // Step 0: Search within starting nodes to select starting match(es)
      const synonyms = await this.getActiveSynonyms();
      const { expandedKeywords } = expandQueryKeywords(queryText, synonyms);

      const crawlNodes: CrawlNode[] = [];
      const crawlEdges: CrawlEdge[] = [];

      type CrawlBranch = {
        currentNode: CrawlNode;
        currentVector: number[];
        currentTopicNodeId: string;
        digsInCurrentTopic: number;
        totalLinks: number;
        totalJumps: number;
        visitedChunkKeys: Set<string>;
        visitedTopicIds: Set<string>;
        groupOrigin?: string;
      };

      let activeBranches: CrawlBranch[] = [];
      const nodeGroupVisits = new Map<string, Set<string>>();
      const groupCentroids = new Map<string, number[]>();
      const groupVectors = new Map<string, number[][]>();

      const getChunkKey = (chunk: {
        sourceId?: string;
        startChar?: number;
        endChar?: number;
        content: string;
      }) =>
        `${chunk.sourceId || ''}:${chunk.startChar || 0}:${chunk.endChar || 0}:${chunk.content.slice(0, 50)}`;

      const resolveSeedVector = async (
        bestSeed: RetrievedChunk,
      ): Promise<number[]> => {
        let seedVector = bestSeed.vector;
        if (!seedVector || seedVector.length === 0) {
          seedVector = vectorCache.get(bestSeed.chunk.content);
        }
        if (!seedVector || seedVector.length === 0) {
          try {
            seedVector =
              (await this.embeddings.embed(bestSeed.chunk.content)) ?? v0;
            if (seedVector && seedVector.length > 0) {
              vectorCache.set(bestSeed.chunk.content, seedVector);
            }
          } catch {
            seedVector = v0;
          }
        }
        return seedVector && seedVector.length > 0 ? seedVector : v0;
      };

      const retrieveGroupBestSeed = async (
        nodeIds: string[],
      ): Promise<RetrievedChunk | null> => {
        const seedRetrieved = await this.retrieve(
          graph.id,
          queryText,
          nodeIds,
          sensitivity,
          'normal',
          viewer.tier,
          synonyms,
        );

        if (seedRetrieved.length > 0 && queryText) {
          try {
            const rerankResults = await this.rerank.rerank(
              queryText,
              seedRetrieved.map((r) => r.chunk.content),
            );
            if (rerankResults && rerankResults.length > 0) {
              for (const item of rerankResults) {
                const target = seedRetrieved[item.index];
                if (target) {
                  target.chunk.rerankScore = item.score;
                  target.chunk.score = item.score;
                }
              }
              seedRetrieved.sort(
                (a, b) =>
                  (b.chunk.rerankScore ?? b.chunk.score) -
                  (a.chunk.rerankScore ?? a.chunk.score),
              );
            }
          } catch {
            // Fall back to initial retrieval ordering
          }
        }

        if (seedRetrieved.length === 0) {
          const seedSources = await this.database.query<DatabaseChunk>(
            `SELECT "id", "nodeId", "name", "content" FROM "NodeSource"
             WHERE "graphId" = $1 AND "nodeId" = ANY($2::text[]) AND "content" IS NOT NULL AND "status" = 'READY'`,
            [graph.id, nodeIds],
          );
          const fallbackChunks = seedSources.flatMap((source) =>
            chunkText(source, graph.id),
          );
          for (const fc of fallbackChunks) {
            seedRetrieved.push({
              chunk: {
                ...fc,
                score: 0.5,
              },
            });
          }
        }

        return seedRetrieved.length > 0 ? seedRetrieved[0]! : null;
      };

      if (isComparative) {
        for (const g of normalizedGroups) {
          const bestSeed = await retrieveGroupBestSeed(g.nodeIds);
          if (!bestSeed) continue;

          const seedVector = await resolveSeedVector(bestSeed);
          const seedNodeTitle =
            nodeMap.get(bestSeed.chunk.nodeId)?.data?.title ||
            bestSeed.chunk.nodeId;
          const seedCrawlNodeId = randomUUID();

          let visitedGroups = nodeGroupVisits.get(bestSeed.chunk.nodeId);
          if (!visitedGroups) {
            visitedGroups = new Set<string>();
            nodeGroupVisits.set(bestSeed.chunk.nodeId, visitedGroups);
          }
          visitedGroups.add(g.id);

          const isIntersection = visitedGroups.size >= 2;

          const rootCrawlNode: CrawlNode = {
            id: seedCrawlNodeId,
            level: 0,
            matchType: 'seed',
            nodeId: bestSeed.chunk.nodeId,
            nodeTitle: seedNodeTitle,
            chunk: bestSeed.chunk,
            score: bestSeed.chunk.rerankScore ?? bestSeed.chunk.score,
            rerankScore: bestSeed.chunk.rerankScore,
            stepDescription: `Starting match for ${g.name} in ${seedNodeTitle}`,
            groupOrigin: isIntersection ? 'intersection' : g.id,
            reachedGroupIds: Array.from(visitedGroups),
          };

          crawlNodes.push(rootCrawlNode);

          if (seedVector && seedVector.length > 0) {
            groupVectors.set(g.id, [seedVector]);
            groupCentroids.set(g.id, computeCentroid([seedVector]));
          }

          activeBranches.push({
            currentNode: rootCrawlNode,
            currentVector: seedVector,
            currentTopicNodeId: bestSeed.chunk.nodeId,
            digsInCurrentTopic: 0,
            totalLinks: 0,
            totalJumps: 0,
            visitedChunkKeys: new Set([getChunkKey(bestSeed.chunk)]),
            visitedTopicIds: new Set([bestSeed.chunk.nodeId]),
            groupOrigin: g.id,
          });
        }

        // If any starting node is shared across multiple groups, ensure all nodes reflect intersection
        for (const node of crawlNodes) {
          const visited = nodeGroupVisits.get(node.nodeId);
          if (visited && visited.size >= 2) {
            node.groupOrigin = 'intersection';
            node.reachedGroupIds = Array.from(visited);
          }
        }
      } else {
        const bestSeed = await retrieveGroupBestSeed(startingNodeIds);
        if (!bestSeed) {
          throw new BadRequestException(
            'No accessible text or documents found in the selected starting nodes.',
          );
        }

        const seedVector = await resolveSeedVector(bestSeed);
        const seedNodeTitle =
          nodeMap.get(bestSeed.chunk.nodeId)?.data?.title ||
          bestSeed.chunk.nodeId;
        const seedCrawlNodeId = randomUUID();

        const rootCrawlNode: CrawlNode = {
          id: seedCrawlNodeId,
          level: 0,
          matchType: 'seed',
          nodeId: bestSeed.chunk.nodeId,
          nodeTitle: seedNodeTitle,
          chunk: bestSeed.chunk,
          score: bestSeed.chunk.rerankScore ?? bestSeed.chunk.score,
          rerankScore: bestSeed.chunk.rerankScore,
          stepDescription: `Starting match in ${seedNodeTitle}`,
        };

        crawlNodes.push(rootCrawlNode);

        activeBranches.push({
          currentNode: rootCrawlNode,
          currentVector: seedVector,
          currentTopicNodeId: bestSeed.chunk.nodeId,
          digsInCurrentTopic: 0,
          totalLinks: 0,
          totalJumps: 0,
          visitedChunkKeys: new Set([getChunkKey(bestSeed.chunk)]),
          visitedTopicIds: new Set([bestSeed.chunk.nodeId]),
        });
      }

      if (crawlNodes.length === 0) {
        throw new BadRequestException(
          'No accessible text or documents found in the selected starting nodes.',
        );
      }

      const seedNodeTitle = isComparative
        ? normalizedGroups.map((g) => g.name).join(' vs ')
        : crawlNodes[0]?.nodeTitle || 'Starting Node';

      this.publishCrawlProgress(graph.id, {
        graphId: graph.id,
        level: 0,
        status: 'starting_match_selected',
        message: isComparative
          ? `Selected starting matches across ${normalizedGroups.length} hypothesis groups`
          : `Selected starting match in ${seedNodeTitle}`,
        matchesCount: crawlNodes.length,
        totalMatches: crawlNodes.length,
        currentNodes: [...crawlNodes],
        currentEdges: [],
        stats: {
          digsCount: 0,
          linksCount: 0,
          jumpsCount: 0,
          seedTitle: seedNodeTitle,
        },
      });

      // Iterative Crawl Level 1..maxDepth
      let currentLevel = 1;
      let wasCancelled = false;
      while (currentLevel <= maxDepth && activeBranches.length > 0) {
        // Check for active cancellation via local signal or Redis
        const isCancelledLocally = abortController.signal.aborted;
        const isCancelledInRedis = this.redisService
          ? await this.redisService.get(`crawl:cancel:${jobId}`)
          : null;
        if (isCancelledLocally || isCancelledInRedis) {
          wasCancelled = true;
          this.logger.log(
            `Crawl job ${jobId} was cancelled at level ${currentLevel}`,
          );
          this.publishCrawlProgress(graph.id, {
            graphId: graph.id,
            level: currentLevel - 1,
            status: 'cancelled',
            message: `Crawl stopped early by user at level ${currentLevel - 1}.`,
            matchesCount: crawlNodes.length,
            totalMatches: crawlNodes.length,
            currentNodes: [...crawlNodes],
            currentEdges: [...crawlEdges],
            stats: {
              digsCount: crawlNodes.filter((n) => n.matchType === 'dig').length,
              linksCount: crawlNodes.filter((n) => n.matchType === 'link')
                .length,
              jumpsCount: crawlNodes.filter((n) => n.matchType === 'jump')
                .length,
              seedTitle: seedNodeTitle,
            },
          });
          break;
        }

        // 1. Prepare target nodes and embeddings across all active branches for batched Weaviate multiVectorSearch
        const branchSearchConfigs = await Promise.all(
          activeBranches.map(async (branch) => {
            const currentTopicTitle =
              nodeMap.get(branch.currentTopicNodeId)?.data?.title ||
              branch.currentTopicNodeId;
            const candidateNeighbors = connectedNodes(
              branch.currentTopicNodeId,
              graph.edges,
              direction,
            );
            const connectedTopicTitles = candidateNeighbors.map(
              (id) => nodeMap.get(id)?.data?.title || id,
            );

            const targetNodeIds: string[] = [];
            if (enableDigs && branch.digsInCurrentTopic < maxDigsPerTopic) {
              targetNodeIds.push(branch.currentTopicNodeId);
            }
            if (
              (enableJumps && branch.totalJumps < maxJumps) ||
              (enableLinks && branch.totalLinks < maxLinks)
            ) {
              for (const nid of candidateNeighbors) {
                if (!targetNodeIds.includes(nid)) {
                  targetNodeIds.push(nid);
                }
              }
            }

            const currentNodeContent = branch.currentNode.chunk.content;
            let nodeVector = branch.currentVector;
            if (!nodeVector || nodeVector.length === 0) {
              nodeVector =
                vectorCache.get(currentNodeContent) ??
                (await this.embeddings.embed(currentNodeContent)) ??
                [];
              if (nodeVector && nodeVector.length > 0) {
                vectorCache.set(currentNodeContent, nodeVector);
              }
            }

            return {
              branch,
              currentTopicTitle,
              candidateNeighbors,
              connectedTopicTitles,
              targetNodeIds,
              currentNodeContent,
              nodeVector,
            };
          }),
        );

        // 2. Execute Weaviate multiVectorSearch in a single batched GraphQL query
        const searchLimit = Math.max(12, maxCandidatesPerStep * 3);
        const batchQueries: VectorSearchQuery[] = branchSearchConfigs
          .filter(
            (cfg) =>
              cfg.targetNodeIds.length > 0 &&
              Array.isArray(cfg.nodeVector) &&
              cfg.nodeVector.length > 0,
          )
          .map((cfg) => ({
            id: cfg.branch.currentNode.id,
            vector: cfg.nodeVector,
            adjacentNodeIds: cfg.targetNodeIds,
            limit: searchLimit,
          }));

        let batchedHitsMap = new Map<string, VectorizedSearchChunk[]>();
        if (batchQueries.length > 0) {
          try {
            batchedHitsMap = await this.weaviate.multiVectorSearch(
              graph.id,
              batchQueries,
              viewer.tier,
            );
          } catch {
            // Fallback to database will occur per branch if Weaviate query fails
          }
        }

        // 3. Evaluate branches and classify candidates with MMR diversity
        const branchEvaluations = await Promise.all(
          branchSearchConfigs.map(async (cfg) => {
            const {
              branch,
              currentTopicTitle,
              candidateNeighbors,
              connectedTopicTitles,
              targetNodeIds,
              currentNodeContent,
              nodeVector,
            } = cfg;

            if (targetNodeIds.length === 0) {
              return { branch, chosenCandidates: [] };
            }

            let candidateChunks: RetrievedChunk[] = [];
            const weaviateHits =
              batchedHitsMap.get(branch.currentNode.id) ?? [];
            if (weaviateHits.length > 0) {
              candidateChunks = weaviateHits.map(({ vector, ...chunk }) => {
                if (vector && vector.length > 0) {
                  vectorCache.set(chunk.content, vector);
                }
                return { chunk, vector };
              });
            }

            if (candidateChunks.length === 0) {
              const candidateSources = await this.database.query<DatabaseChunk>(
                `SELECT "id", "nodeId", "name", "content" FROM "NodeSource"
                 WHERE "graphId" = $1 AND "nodeId" = ANY($2::text[]) AND "content" IS NOT NULL AND "status" = 'READY'`,
                [graph.id, targetNodeIds],
              );
              const allChunks = candidateSources.flatMap((source) =>
                chunkText(source, graph.id),
              );
              candidateChunks = allChunks
                .map((chunk) => {
                  const simScore = lexicalScore(
                    chunk.content,
                    currentNodeContent,
                  );
                  return {
                    chunk: { ...chunk, score: simScore },
                  };
                })
                .sort((a, b) => b.chunk.score - a.chunk.score)
                .slice(0, Math.max(12, maxCandidatesPerStep * 3));
            }

            const unvisitedCandidates = candidateChunks.filter((candidate) => {
              const cKey = getChunkKey(candidate.chunk);
              if (branch.visitedChunkKeys.has(cKey)) return false;
              if (candidate.chunk.content === currentNodeContent) return false;
              const overlap = lexicalScore(
                currentNodeContent,
                candidate.chunk.content,
              );
              const words = candidate.chunk.content.split(/\s+/).length;
              if (words > 0 && overlap / words > 0.85) return false;
              return true;
            });

            if (unvisitedCandidates.length === 0) {
              return { branch, chosenCandidates: [] };
            }

            try {
              const rerankResults = await this.rerank.rerank(
                currentNodeContent.slice(0, 300),
                unvisitedCandidates.map((c) => c.chunk.content),
              );
              if (rerankResults && rerankResults.length > 0) {
                for (const item of rerankResults) {
                  const target = unvisitedCandidates[item.index];
                  if (target) {
                    target.chunk.rerankScore = item.score;
                    target.chunk.score = item.score;
                  }
                }
                unvisitedCandidates.sort(
                  (a, b) =>
                    (b.chunk.rerankScore ?? b.chunk.score) -
                    (a.chunk.rerankScore ?? a.chunk.score),
                );
              }
            } catch {
              // Maintain retrieval order
            }

            const qualifyingCandidates: ClassifiedCandidateItem<RetrievedChunk>[] =
              [];

            for (const cand of unvisitedCandidates) {
              const score = cand.chunk.rerankScore ?? cand.chunk.score;
              if (score < minScore) {
                continue;
              }

              const isAdjacent = candidateNeighbors.includes(cand.chunk.nodeId);
              const candVector =
                cand.vector && cand.vector.length > 0
                  ? cand.vector
                  : vectorCache.get(cand.chunk.content);
              let semanticSimilarity: number | undefined;
              if (
                nodeVector &&
                nodeVector.length > 0 &&
                candVector &&
                candVector.length > 0
              ) {
                semanticSimilarity = cosineSimilarity(nodeVector, candVector);
              } else if (
                typeof cand.chunk.score === 'number' &&
                cand.chunk.score > 0 &&
                cand.chunk.score <= 1.0
              ) {
                semanticSimilarity = cand.chunk.score;
              }

              const matchType = classifyCrawlCandidate({
                candidateNodeId: cand.chunk.nodeId,
                currentNodeId: branch.currentTopicNodeId,
                currentTopicTitle,
                candidateContent: cand.chunk.content,
                isAdjacentInGraph: isAdjacent,
                connectedTopicTitles,
                enableDigs,
                digsInCurrentTopic: branch.digsInCurrentTopic,
                maxDigsPerTopic,
                enableLinks,
                totalLinks: branch.totalLinks,
                maxLinks,
                enableJumps,
                totalJumps: branch.totalJumps,
                maxJumps,
                semanticSimilarity,
                densityParams: {
                  nodeCount: graph.nodes?.length ?? 0,
                  edgeCount: graph.edges?.length ?? 0,
                  localDegree: candidateNeighbors.length,
                  avgDegree:
                    (graph.nodes?.length ?? 0) > 0
                      ? (2 * (graph.edges?.length ?? 0)) / graph.nodes.length
                      : 2,
                  sensitivity: dto.sensitivity,
                },
              });

              if (matchType) {
                qualifyingCandidates.push({
                  candidate: cand,
                  matchType,
                  score,
                  nodeId: cand.chunk.nodeId,
                  content: cand.chunk.content,
                  vector: candVector,
                });
              }
            }

            // Apply MMR diversity selection within the branch up to maxCandidatesPerStep
            let otherGroupCentroids: number[][] | undefined = undefined;
            if (isComparative && branch.groupOrigin) {
              otherGroupCentroids = [];
              for (const [gId, centroid] of groupCentroids.entries()) {
                if (gId !== branch.groupOrigin && centroid.length > 0) {
                  otherGroupCentroids.push(centroid);
                }
              }
            }

            const diverseSelected = selectDiverseCandidatesMmr(
              qualifyingCandidates,
              maxCandidatesPerStep,
              0.7,
              0.85,
              otherGroupCentroids,
            );

            const chosenCandidates = diverseSelected.map((item) => ({
              candidate: item.candidate,
              matchType: item.matchType,
            }));

            return { branch, chosenCandidates };
          }),
        );

        // 2. Batch resolve embeddings across candidates lacking cached vectors
        const chunksNeedingEmbed: string[] = [];
        const chunkEmbedMap = new Map<string, number[]>();

        for (const { chosenCandidates } of branchEvaluations) {
          for (const { candidate } of chosenCandidates) {
            if (!candidate.vector || candidate.vector.length === 0) {
              const cached = vectorCache.get(candidate.chunk.content);
              if (cached && cached.length > 0) {
                candidate.vector = cached;
              } else if (!chunkEmbedMap.has(candidate.chunk.content)) {
                chunksNeedingEmbed.push(candidate.chunk.content);
                chunkEmbedMap.set(candidate.chunk.content, []);
              }
            }
          }
        }

        if (chunksNeedingEmbed.length > 0) {
          try {
            const batchVectors =
              await this.embeddings.embedBatch(chunksNeedingEmbed);
            chunksNeedingEmbed.forEach((content, idx) => {
              const vec = batchVectors[idx];
              if (vec && vec.length > 0) {
                chunkEmbedMap.set(content, vec);
                vectorCache.set(content, vec);
              }
            });
          } catch {
            // Fall back to branch vectors
          }
        }

        let nextBranches: CrawlBranch[] = [];

        for (const { branch, chosenCandidates } of branchEvaluations) {
          for (const { candidate, matchType } of chosenCandidates) {
            let nextVector = candidate.vector;
            if (!nextVector || nextVector.length === 0) {
              nextVector =
                vectorCache.get(candidate.chunk.content) ??
                branch.currentVector;
            }

            let similarityScore: number | undefined = undefined;
            if (branch.currentVector?.length > 0 && nextVector?.length > 0) {
              const rawSim = cosineSimilarity(branch.currentVector, nextVector);
              similarityScore = Number(rawSim.toFixed(4));
            }

            const candidateNodeTitle =
              nodeMap.get(candidate.chunk.nodeId)?.data?.title ||
              candidate.chunk.nodeId;
            const nextCrawlNodeId = randomUUID();

            let stepDesc = '';
            let nextDigs = branch.digsInCurrentTopic;
            let nextLinks = branch.totalLinks;
            let nextJumps = branch.totalJumps;
            let nextTopicNodeId = branch.currentTopicNodeId;

            if (matchType === 'dig') {
              nextDigs += 1;
              stepDesc = `Dig #${nextDigs}: Deepened details in ${candidateNodeTitle}`;
            } else if (matchType === 'link') {
              nextLinks += 1;
              stepDesc = `Link #${nextLinks}: Perspective connecting to ${candidateNodeTitle}`;
            } else if (matchType === 'jump') {
              nextJumps += 1;
              nextDigs = 0; // Digs counter restarted on jump!
              nextTopicNodeId = candidate.chunk.nodeId;
              stepDesc = `Jump #${nextJumps}: Traversed topic to ${candidateNodeTitle}`;
            }

            if (branch.groupOrigin) {
              let visitedGroups = nodeGroupVisits.get(candidate.chunk.nodeId);
              if (!visitedGroups) {
                visitedGroups = new Set<string>();
                nodeGroupVisits.set(candidate.chunk.nodeId, visitedGroups);
              }
              visitedGroups.add(branch.groupOrigin);
            }

            const visitedGroups = nodeGroupVisits.get(candidate.chunk.nodeId);
            const isIntersection = visitedGroups && visitedGroups.size >= 2;

            const newCrawlNode: CrawlNode = {
              id: nextCrawlNodeId,
              level: currentLevel,
              matchType,
              nodeId: candidate.chunk.nodeId,
              nodeTitle: candidateNodeTitle,
              chunk: candidate.chunk,
              score: candidate.chunk.rerankScore ?? candidate.chunk.score,
              rerankScore: candidate.chunk.rerankScore,
              parentCrawlNodeId: branch.currentNode.id,
              stepDescription: stepDesc,
              groupOrigin: isIntersection ? 'intersection' : branch.groupOrigin,
              reachedGroupIds: visitedGroups
                ? Array.from(visitedGroups)
                : branch.groupOrigin
                  ? [branch.groupOrigin]
                  : undefined,
            };

            const sharedKeywords = extractSharedKeywords(
              branch.currentNode.chunk.content,
              candidate.chunk.content,
              4,
            );

            const newCrawlEdge: CrawlEdge = {
              id: randomUUID(),
              source: branch.currentNode.id,
              target: newCrawlNode.id,
              level: currentLevel,
              matchType,
              direction,
              similarityScore,
              sharedKeywords:
                sharedKeywords.length > 0 ? sharedKeywords : undefined,
            };

            crawlNodes.push(newCrawlNode);
            crawlEdges.push(newCrawlEdge);

            const nextVisitedChunkKeys = new Set(branch.visitedChunkKeys);
            nextVisitedChunkKeys.add(getChunkKey(candidate.chunk));

            const nextVisitedTopics = new Set(branch.visitedTopicIds);
            nextVisitedTopics.add(candidate.chunk.nodeId);

            nextBranches.push({
              currentNode: newCrawlNode,
              currentVector: nextVector,
              currentTopicNodeId: nextTopicNodeId,
              digsInCurrentTopic: nextDigs,
              totalLinks: nextLinks,
              totalJumps: nextJumps,
              visitedChunkKeys: nextVisitedChunkKeys,
              visitedTopicIds: nextVisitedTopics,
              groupOrigin: branch.groupOrigin,
            });

            // Update group vector and centroid
            if (branch.groupOrigin && nextVector && nextVector.length > 0) {
              const currentVectors = groupVectors.get(branch.groupOrigin) ?? [];
              currentVectors.push(nextVector);
              groupVectors.set(branch.groupOrigin, currentVectors);
              groupCentroids.set(
                branch.groupOrigin,
                computeCentroid(currentVectors),
              );
            }
          }
        }

        if (isComparative) {
          for (const node of crawlNodes) {
            const visited = nodeGroupVisits.get(node.nodeId);
            if (visited && visited.size >= 2) {
              node.groupOrigin = 'intersection';
              node.reachedGroupIds = Array.from(visited);
            }
          }
        }

        // Cross-branch beam pruning and deduplication across parallel paths
        nextBranches = pruneAndDeduplicateBranches(
          nextBranches,
          8,
          0.85,
          isComparative,
        );

        activeBranches = nextBranches;

        const MAX_CRAWL_NODES = 40;
        if (crawlNodes.length >= MAX_CRAWL_NODES) {
          break;
        }

        const currentDigsCount = crawlNodes.filter(
          (n) => n.matchType === 'dig',
        ).length;
        const currentLinksCount = crawlNodes.filter(
          (n) => n.matchType === 'link',
        ).length;
        const currentJumpsCount = crawlNodes.filter(
          (n) => n.matchType === 'jump',
        ).length;

        this.publishCrawlProgress(graph.id, {
          graphId: graph.id,
          level: currentLevel,
          status: 'hop_evaluated',
          message: `Hop ${currentLevel}: Discovered ${crawlNodes.length} matches (${currentDigsCount} digs, ${currentLinksCount} links, ${currentJumpsCount} jumps)`,
          matchesCount: crawlNodes.length,
          totalMatches: crawlNodes.length,
          currentNodes: [...crawlNodes],
          currentEdges: [...crawlEdges],
          stats: {
            digsCount: currentDigsCount,
            linksCount: currentLinksCount,
            jumpsCount: currentJumpsCount,
            seedTitle: seedNodeTitle,
          },
        });

        currentLevel++;
      }

      const matchedNodeIds = [...new Set(crawlNodes.map((n) => n.nodeId))];
      const maxLevelReached = crawlNodes.reduce(
        (max, n) => Math.max(max, n.level),
        0,
      );
      const totalMatches = crawlNodes.length;

      const digsCount = crawlNodes.filter((n) => n.matchType === 'dig').length;
      const linksCount = crawlNodes.filter(
        (n) => n.matchType === 'link',
      ).length;
      const jumpsCount = crawlNodes.filter(
        (n) => n.matchType === 'jump',
      ).length;

      let comparativeData: CrawlResponse['comparative'] = undefined;
      if (isComparative) {
        const intersectionNodeTitles = [
          ...new Set(
            crawlNodes
              .filter((n) => n.groupOrigin === 'intersection')
              .map((n) => n.nodeTitle),
          ),
        ];

        const group0Id = normalizedGroups[0]?.id;
        const group1Id = normalizedGroups[1]?.id;

        const groupACount = group0Id
          ? crawlNodes.filter((n) => n.groupOrigin === group0Id).length
          : 0;
        const groupBCount = group1Id
          ? crawlNodes.filter((n) => n.groupOrigin === group1Id).length
          : 0;
        const intersectionCount = crawlNodes.filter(
          (n) => n.groupOrigin === 'intersection',
        ).length;

        const groupSummaries: ComparativeGroupSummary[] = normalizedGroups.map(
          (g) => {
            const gNodes = crawlNodes.filter(
              (n) =>
                n.groupOrigin === g.id || n.reachedGroupIds?.includes(g.id),
            );
            const avgScore =
              gNodes.length > 0
                ? Number(
                    (
                      gNodes.reduce(
                        (sum, n) => sum + (n.rerankScore ?? n.score),
                        0,
                      ) / gNodes.length
                    ).toFixed(4),
                  )
                : 0;

            return {
              id: g.id,
              name: g.name,
              count: crawlNodes.filter((n) => n.groupOrigin === g.id).length,
              color: g.color,
              avgScore,
              entropy: computeGraphEntropy(gNodes),
            };
          },
        );

        comparativeData = {
          isComparative: true,
          groupACount,
          groupBCount,
          intersectionCount,
          intersectionNodeTitles,
          groups: groupSummaries,
        };
      }

      let summary = wasCancelled
        ? `Crawl stopped by user at level ${maxLevelReached + 1} with ${totalMatches} match(es).`
        : totalMatches > 1
          ? `Explored from "${seedNodeTitle}": ${digsCount} dig(s), ${linksCount} link(s), and ${jumpsCount} jump(s) across ${matchedNodeIds.length} topic(s).`
          : `Started from "${seedNodeTitle}", but no further relevant connections met the threshold.`;

      if (isComparative) {
        const groupNames = normalizedGroups.map((g) => g.name).join(' vs ');
        const intersectionCount =
          comparativeData?.intersectionNodeTitles.length ?? 0;
        summary = wasCancelled
          ? `Comparative crawl (${groupNames}) stopped by user at level ${maxLevelReached + 1} with ${totalMatches} match(es).`
          : `Comparative crawl (${groupNames}): explored ${totalMatches} match(es) across ${matchedNodeIds.length} topic(s) with ${intersectionCount} intersection topic(s).`;
      }

      const stats: CrawlSummaryStats = {
        digsCount,
        linksCount,
        jumpsCount,
        seedTitle: seedNodeTitle,
      };

      const crawlResponse: CrawlResponse = {
        queryId: '',
        jobId,
        queryType: 'crawl',
        queryText: queryText,
        expandedKeywords,
        startingNodeIds,
        crawlDepth: crawlDepth ?? 'default',
        direction,
        sensitivity,
        nodes: crawlNodes,
        edges: crawlEdges,
        maxLevelReached,
        totalMatches,
        matchedNodeIds,
        remaining: quota.remaining,
        searchSpaceMultiplier: quota.searchSpaceMultiplier ?? 1.0,
        creditsCost: 0,
        summary,
        stats,
        comparative: comparativeData,
      };

      const [stored] = await this.database.query<{ id: string }>(
        `INSERT INTO "Query" ("id", "userId", "graphId", "queryText", "selectedNodeIds", "results", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, CURRENT_TIMESTAMP)
         RETURNING "id"`,
        [
          randomUUID(),
          viewer.userId,
          graph.id,
          queryText,
          JSON.stringify(startingNodeIds),
          JSON.stringify(crawlResponse),
        ],
      );

      if (!stored) {
        throw new NotFoundException('Query could not be recorded.');
      }
      crawlResponse.queryId = stored.id;

      if (!wasCancelled) {
        this.publishCrawlProgress(graph.id, {
          graphId: graph.id,
          level: maxLevelReached,
          status: 'completed',
          message: `Crawl complete. Traversed ${maxLevelReached + 1} levels with ${crawlNodes.length} matches.`,
          matchesCount: crawlNodes.length,
          totalMatches: crawlNodes.length,
          currentNodes: [...crawlNodes],
          currentEdges: [...crawlEdges],
          stats,
        });
      }

      return crawlResponse;
    } finally {
      this.activeCrawlControllers.delete(jobId);
    }
  }

  private computeAverageFrontierEntropy(nodes: CrawlNode[]): number {
    const scored = nodes.filter((n) => typeof n.branchEntropy === 'number');
    if (scored.length === 0) return 0;
    const sum = scored.reduce((acc, n) => acc + (n.branchEntropy ?? 0), 0);
    return Math.round((sum / scored.length) * 1000) / 1000;
  }

  private publishCrawlProgress(
    graphId: string,
    payload: {
      graphId: string;
      level: number;
      status: string;
      message: string;
      matchesCount?: number;
      totalMatches?: number;
      currentNodes?: CrawlNode[];
      currentEdges?: CrawlEdge[];
      stats?: CrawlSummaryStats;
      maxBranchEntropy?: number;
      prunedBranchesCount?: number;
      averageBranchEntropy?: number;
    },
  ): void {
    try {
      void this.redisService
        ?.publish('crawl:progress', JSON.stringify(payload))
        .catch(() => {});
    } catch {
      // Non-blocking
    }
  }
}
