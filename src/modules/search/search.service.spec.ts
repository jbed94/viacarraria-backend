jest.mock('better-auth', () => ({ betterAuth: jest.fn() }));
jest.mock('better-auth/plugins', () => ({ anonymous: jest.fn() }));
jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn() }));
jest.mock('../../auth.js', () => ({
  auth: {
    api: {
      getSession: jest.fn(),
    },
  },
}));

import {
  adjacentNodes,
  adjustCrawlVector,
  applyTabularBoosting,
  chunkText,
  computeBranchEntropy,
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
  normalizeVector,
  selectDiverseBranches,
  vectorNorm,
} from './search.utils.js';
import type { SearchChunk } from '../../common/types.js';
import { UnauthorizedException } from '@nestjs/common';
import { SearchService } from './search.service.js';
import type { DatabaseService } from '../../common/services/database.service.js';
import type { EmbeddingService } from '../../common/services/embedding.service.js';
import type { RerankService } from '../../common/services/rerank.service.js';
import type { WeaviateService } from '../../common/services/weaviate.service.js';
import type { GraphsService } from '../graphs/graphs.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { AuthorizationService } from '../../common/authorization/ability.js';
import type { RedisService } from '../../common/services/redis.service.js';

describe('SearchService Helpers & Chunking', () => {
  describe('chunkText', () => {
    it('splits markdown document into granular paragraphs and sections', () => {
      const source = {
        id: 'source-1',
        nodeId: 'node-1',
        name: 'Databases.md',
        content: `# Section One\n\nFirst paragraph about B-Trees and indexing.\n\n## Section Two\n\nSecond paragraph explaining ACID and isolation levels.`,
      };

      const chunks = chunkText(source, 'graph-1');
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks[0]!.content).toContain('# Section One');
      expect(chunks[1]!.content).toContain('First paragraph about B-Trees');
      expect(chunks[2]!.content).toContain('## Section Two');

      for (const chunk of chunks) {
        expect(chunk.nodeId).toBe('node-1');
        expect(chunk.graphId).toBe('graph-1');
        expect(chunk.sourceId).toBe('source-1');
        expect(chunk.endChar).toBeGreaterThan(chunk.startChar);
        expect(source.content.slice(chunk.startChar, chunk.endChar)).toContain(
          chunk.content.slice(0, 10),
        );
      }
    });

    it('returns empty array for empty source content', () => {
      const chunks = chunkText(
        { id: 's', nodeId: 'n', name: 'empty', content: '   ' },
        'g',
      );
      expect(chunks).toEqual([]);
    });
  });

  describe('adjacentNodes', () => {
    it('finds both incoming and outgoing connected node IDs', () => {
      const edges = [
        { source: 'node-a', target: 'node-b' },
        { source: 'node-c', target: 'node-a' },
        { source: 'node-x', target: 'node-y' },
      ];

      const adjacent = adjacentNodes('node-a', edges);
      expect(adjacent).toEqual(expect.arrayContaining(['node-b', 'node-c']));
      expect(adjacent).not.toContain('node-x');
      expect(adjacent).not.toContain('node-a');
    });
  });

  describe('connectedNodes', () => {
    const edges = [
      { source: 'node-a', target: 'node-b' },
      { source: 'node-c', target: 'node-a' },
      { source: 'node-a', target: 'node-d' },
    ];

    it('traverses forward outgoing edges', () => {
      expect(connectedNodes('node-a', edges, 'forward')).toEqual([
        'node-b',
        'node-d',
      ]);
    });

    it('traverses backward incoming edges', () => {
      expect(connectedNodes('node-a', edges, 'backward')).toEqual(['node-c']);
    });

    it('traverses both incoming and outgoing edges for undirected mode', () => {
      expect(connectedNodes('node-a', edges, 'both')).toEqual(
        expect.arrayContaining(['node-b', 'node-c', 'node-d']),
      );
    });

    it('prioritizes edges with higher semantic relation weight in candidate ordering', () => {
      const weightedEdges = [
        {
          source: 'node-a',
          target: 'node-b',
          data: { relation: 'references' }, // 0.9
        },
        {
          source: 'node-a',
          target: 'node-c',
          data: { relation: 'parent_of' }, // 1.5
        },
        {
          source: 'node-a',
          target: 'node-d',
          data: { relation: 'relates_to' }, // 1.0
        },
      ];
      expect(connectedNodes('node-a', weightedEdges, 'forward')).toEqual([
        'node-c',
        'node-d',
        'node-b',
      ]);
    });
  });

  describe('computeGraphDepthMetrics', () => {
    it('computes reachable hops and dynamic depth caps from starting seeds', () => {
      const nodes = [
        { id: 'n1' },
        { id: 'n2' },
        { id: 'n3' },
        { id: 'n4' },
        { id: 'n5' },
      ];
      const edges = [
        { source: 'n1', target: 'n2' },
        { source: 'n2', target: 'n3' },
        { source: 'n3', target: 'n4' },
        { source: 'n4', target: 'n5' },
      ];
      const metrics = computeGraphDepthMetrics(nodes, edges, ['n1'], 'forward');
      expect(metrics.maxReachableHops).toBe(4);
      expect(metrics.totalReachableNodes).toBe(5);
      expect(metrics.depthLimits.shallow).toBeGreaterThanOrEqual(1);
      expect(metrics.depthLimits.default).toBeGreaterThanOrEqual(2);
      expect(metrics.depthLimits.deep).toBe(4);
      expect(metrics.depthLimits.unlimited).toBe(4);
    });
  });

  describe('Vector linear algebra & Rocchio feedback', () => {
    it('normalizes vector to unit length', () => {
      const v = [3, 4];
      const norm = vectorNorm(v);
      expect(norm).toBe(5);
      const normalized = normalizeVector(v);
      expect(normalized[0]).toBeCloseTo(0.6);
      expect(normalized[1]).toBeCloseTo(0.8);
      expect(vectorNorm(normalized)).toBeCloseTo(1.0);
    });

    it('computes cosine similarity accurately', () => {
      expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1.0);
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
    });

    it('steers crawl query vector by reinforcing current state and subtracting previous state', () => {
      const v0 = [1, 0, 0];
      const vCurrent = [0, 1, 0];
      const vPrev = [0, 0, 1];

      const adjusted = adjustCrawlVector(v0, vCurrent, vPrev, 0.5, 0.4, 0.2);
      expect(vectorNorm(adjusted)).toBeCloseTo(1.0);
      expect(cosineSimilarity(adjusted, v0)).toBeGreaterThan(0.5);
      expect(cosineSimilarity(adjusted, vCurrent)).toBeGreaterThan(0.4);
      expect(cosineSimilarity(adjusted, vPrev)).toBeLessThan(0);
    });
  });

  describe('extractSharedKeywords', () => {
    it('extracts top shared meaningful keywords while ignoring common stop words', () => {
      const textA =
        'Distributed consensus algorithms ensure fault tolerance in decentralized systems.';
      const textB =
        'In decentralized cloud architecture, consensus and fault tolerance maintain reliability.';

      const shared = extractSharedKeywords(textA, textB, 5);
      expect(shared).toContain('consensus');
      expect(shared).toContain('fault');
      expect(shared).toContain('tolerance');
      expect(shared).toContain('decentralized');
      expect(shared).not.toContain('in');
      expect(shared).not.toContain('and');
    });

    it('returns empty array if texts have no overlapping terms or are empty', () => {
      expect(extractSharedKeywords('', 'some text')).toEqual([]);
      expect(
        extractSharedKeywords('apples bananas', 'peaches oranges'),
      ).toEqual([]);
    });
  });

  describe('expandQueryKeywords', () => {
    it('expands common technical acronyms into full terms', () => {
      const res1 = expandQueryKeywords('k8s deployment');
      expect(res1.expandedQuery).toBe('k8s deployment kubernetes');
      expect(res1.expandedKeywords).toEqual(['kubernetes']);

      const res2 = expandQueryKeywords('distributed db consensus');
      expect(res2.expandedQuery).toBe('distributed db consensus database');
      expect(res2.expandedKeywords).toEqual(['database']);

      const res3 = expandQueryKeywords('graph traversal with bfs');
      expect(res3.expandedQuery).toBe(
        'graph traversal with bfs breadth-first search',
      );
      expect(res3.expandedKeywords).toEqual(['breadth-first search']);

      const res4 = expandQueryKeywords('graph traversal with dfs');
      expect(res4.expandedQuery).toBe(
        'graph traversal with dfs depth-first search',
      );
      expect(res4.expandedKeywords).toEqual(['depth-first search']);

      const res5 = expandQueryKeywords('calculate mst');
      expect(res5.expandedQuery).toBe('calculate mst minimum spanning tree');
      expect(res5.expandedKeywords).toEqual(['minimum spanning tree']);

      const res6 = expandQueryKeywords('rest api design');
      expect(res6.expandedQuery).toBe(
        'rest api design application programming interface',
      );
      expect(res6.expandedKeywords).toEqual([
        'application programming interface',
      ]);

      const res7 = expandQueryKeywords('ai and ml in modern nlp');
      expect(res7.expandedQuery).toBe(
        'ai and ml in modern nlp artificial intelligence machine learning natural language processing',
      );
      expect(res7.expandedKeywords).toEqual([
        'artificial intelligence',
        'machine learning',
        'natural language processing',
      ]);
    });

    it('expands reverse terms to acronyms', () => {
      const res1 = expandQueryKeywords('kubernetes cluster');
      expect(res1.expandedQuery).toBe('kubernetes cluster k8s');
      expect(res1.expandedKeywords).toEqual(['k8s']);

      const res2 = expandQueryKeywords('relational database schema');
      expect(res2.expandedQuery).toBe('relational database schema db');
      expect(res2.expandedKeywords).toEqual(['db']);
    });

    it('supports custom dynamic synonyms dictionary', () => {
      const custom = {
        hnsw: ['hierarchical navigable small world'],
        paxos: ['distributed consensus'],
      };
      const res = expandQueryKeywords('vector indexing with hnsw', custom);
      expect(res.expandedQuery).toBe(
        'vector indexing with hnsw hierarchical navigable small world',
      );
      expect(res.expandedKeywords).toEqual([
        'hierarchical navigable small world',
      ]);
    });

    it('does not duplicate synonyms if already present in query', () => {
      const res1 = expandQueryKeywords('kubernetes k8s orchestration');
      expect(res1.expandedQuery).toBe('kubernetes k8s orchestration');
      expect(res1.expandedKeywords).toEqual([]);

      const res2 = expandQueryKeywords('database db schema');
      expect(res2.expandedQuery).toBe('database db schema');
      expect(res2.expandedKeywords).toEqual([]);
    });

    it('returns original string if no synonyms match or string is empty', () => {
      expect(expandQueryKeywords('simple random text')).toEqual({
        expandedQuery: 'simple random text',
        expandedKeywords: [],
      });
      expect(expandQueryKeywords('')).toEqual({
        expandedQuery: '',
        expandedKeywords: [],
      });
      expect(expandQueryKeywords('   ')).toEqual({
        expandedQuery: '   ',
        expandedKeywords: [],
      });
    });
  });

  describe('groupChunks', () => {
    const makeChunk = (nodeId: string, idx: number): SearchChunk => ({
      graphId: 'g',
      sourceId: 's',
      sourceName: 'src',
      nodeId,
      content: `Chunk ${idx}`,
      context: `Context ${idx}`,
      startChar: idx * 10,
      endChar: (idx + 1) * 10,
      pageNum: 1,
      score: 10 - idx,
    });

    it('enforces narrow scope limit (max 2 per node)', () => {
      const chunks = [0, 1, 2, 3].map((i) => makeChunk('node-1', i));
      const grouped = groupChunks(chunks, 'narrow');
      expect(grouped[0]!.chunks).toHaveLength(2);
      expect(grouped[0]!.matchCount).toBe(2);
    });

    it('enforces wide scope limit (up to 8 per node)', () => {
      const chunks = Array.from({ length: 10 }, (_, i) =>
        makeChunk('node-1', i),
      );
      const grouped = groupChunks(chunks, 'wide');
      expect(grouped[0]!.chunks).toHaveLength(8);
      expect(grouped[0]!.matchCount).toBe(8);
    });
  });

  describe('lexicalScore', () => {
    it('scores matches based on term frequency', () => {
      const text = 'Postgres uses MVCC. MVCC guarantees consistent snapshots.';
      expect(lexicalScore(text, 'MVCC')).toBe(2);
      expect(lexicalScore(text, 'Postgres')).toBe(1);
      expect(lexicalScore(text, 'Redis')).toBe(0);
    });
  });

  describe('Tabular Query Detection & Boosting', () => {
    it('detects tabular queries by keywords', () => {
      expect(isTabularQuery('grading breakdown')).toBe(true);
      expect(isTabularQuery('exam schedule')).toBe(true);
      expect(isTabularQuery('course credits table')).toBe(true);
      expect(isTabularQuery('explain red-black trees')).toBe(false);
    });

    it('identifies table chunks via elementType or markdown table structure', () => {
      expect(isTableChunk({ elementType: 'table', content: 'any text' })).toBe(
        true,
      );
      expect(
        isTableChunk({
          content: '| Item | Weight |\n|---|---|\n| Midterm | 30% |',
        }),
      ).toBe(true);
      expect(isTableChunk({ content: 'Just a regular sentence.' })).toBe(false);
    });

    it('boosts table chunk scores when query has tabular intent', () => {
      const textChunk: SearchChunk = {
        graphId: 'g',
        sourceId: 's',
        sourceName: 'src',
        nodeId: 'n1',
        content: 'Overview of grading policy.',
        context: 'Overview of grading policy.',
        startChar: 0,
        endChar: 25,
        pageNum: 1,
        score: 0.8,
        elementType: 'text',
      };
      const tableChunk: SearchChunk = {
        graphId: 'g',
        sourceId: 's',
        sourceName: 'src',
        nodeId: 'n1',
        content: '| Exam | Weight |\n|---|---|\n| Final | 50% |',
        context: 'Full table context',
        startChar: 30,
        endChar: 75,
        pageNum: 1,
        score: 0.7,
        elementType: 'table',
      };

      // Non-tabular query does not boost
      const unboosted = applyTabularBoosting(
        [{ chunk: textChunk }, { chunk: tableChunk }],
        'what is recursion',
      );
      expect(unboosted[0]!.chunk.score).toBe(0.8);
      expect(unboosted[1]!.chunk.score).toBe(0.7);

      // Tabular query boosts tableChunk (0.7 * 1.35 = 0.945), sorting it to top
      const boosted = applyTabularBoosting(
        [{ chunk: textChunk }, { chunk: tableChunk }],
        'grading breakdown table',
      );
      expect(boosted[0]!.chunk.elementType).toBe('table');
      expect(boosted[0]!.chunk.score).toBeGreaterThan(0.9);
      expect(boosted[1]!.chunk.score).toBe(0.8);
    });
  });

  describe('computeGraphEntropy', () => {
    it('returns 0 for empty or single node graph', () => {
      expect(computeGraphEntropy([])).toBe(0);
      expect(
        computeGraphEntropy([
          {
            id: 'n1',
            level: 0,
            nodeId: 'n1',
            nodeTitle: 'Root',
            chunk: {} as any,
            score: 0.9,
          },
        ]),
      ).toBe(0);
    });

    it('computes normalized entropy in [0, 1] across node scores and edge weights', () => {
      const nodes: any[] = [
        { id: 'c1', nodeId: 'n1', score: 0.95, rerankScore: 0.98 },
        { id: 'c2', nodeId: 'n2', score: 0.2, rerankScore: 0.15 },
      ];
      const edges: any[] = [
        { id: 'e1', source: 'c1', target: 'c2', similarityScore: 0.8 },
      ];
      const entropy = computeGraphEntropy(nodes, edges);
      expect(entropy).toBeGreaterThan(0);
      expect(entropy).toBeLessThan(1);
    });

    it('yields lower entropy for focused/pure relevance distribution than uniform noisy distribution', () => {
      const focusedNodes: any[] = [
        { id: 'c1', nodeId: 'n1', score: 0.99, rerankScore: 0.99 },
        { id: 'c2', nodeId: 'n2', score: 0.05, rerankScore: 0.05 },
        { id: 'c3', nodeId: 'n3', score: 0.05, rerankScore: 0.05 },
      ];
      const uniformNodes: any[] = [
        { id: 'c1', nodeId: 'n1', score: 0.5, rerankScore: 0.5 },
        { id: 'c2', nodeId: 'n2', score: 0.5, rerankScore: 0.5 },
        { id: 'c3', nodeId: 'n3', score: 0.5, rerankScore: 0.5 },
      ];

      const focusedEntropy = computeGraphEntropy(focusedNodes, []);
      const uniformEntropy = computeGraphEntropy(uniformNodes, []);

      expect(focusedEntropy).toBeLessThan(uniformEntropy);
      expect(uniformEntropy).toBeCloseTo(1.0, 1);
    });
  });

  describe('computeBranchEntropy', () => {
    it('returns 0 for empty or single node path', () => {
      expect(computeBranchEntropy([])).toBe(0);
      expect(
        computeBranchEntropy([
          {
            id: 'c1',
            level: 0,
            nodeId: 'n1',
            nodeTitle: 'Root',
            score: 0.95,
            chunk: {} as any,
          },
        ]),
      ).toBe(0);
    });

    it('computes low entropy for pristine cohesive branch and high entropy for drifted branch', () => {
      const seedNode: any = {
        id: 'c1',
        nodeId: 'n1',
        score: 0.95,
        rerankScore: 0.95,
      };
      const cohesiveHop: any = {
        id: 'c2',
        nodeId: 'n2',
        score: 0.92,
        rerankScore: 0.92,
      };
      const driftedHop: any = {
        id: 'c3',
        nodeId: 'n3',
        score: 0.25,
        rerankScore: 0.25,
      };

      const cohesiveEdge: any = {
        id: 'e1',
        source: 'c1',
        target: 'c2',
        similarityScore: 0.92,
      };
      const driftedEdge: any = {
        id: 'e2',
        source: 'c1',
        target: 'c3',
        similarityScore: 0.2,
      };

      const cohesiveEntropy = computeBranchEntropy(
        [seedNode, cohesiveHop],
        [cohesiveEdge],
      );
      const driftedEntropy = computeBranchEntropy(
        [seedNode, driftedHop],
        [driftedEdge],
      );

      expect(cohesiveEntropy).toBeGreaterThanOrEqual(0);
      expect(cohesiveEntropy).toBeLessThan(0.35); // Pristine / focused
      expect(driftedEntropy).toBeGreaterThan(0.7); // High disorder / topic drift
      expect(cohesiveEntropy).toBeLessThan(driftedEntropy);
    });

    it('clamps output strictly within [0, 1]', () => {
      const seedNode: any = { id: 'c1', nodeId: 'n1', score: 0.01 };
      const extremeDrift: any = { id: 'c2', nodeId: 'n2', score: 0.01 };
      const zeroEdge: any = {
        id: 'e1',
        source: 'c1',
        target: 'c2',
        similarityScore: 0.0,
      };

      const entropy = computeBranchEntropy(
        [seedNode, extremeDrift],
        [zeroEdge],
      );
      expect(entropy).toBeLessThanOrEqual(1.0);
      expect(entropy).toBeGreaterThanOrEqual(0.0);
    });
  });

  describe('determineAdaptiveMaxBranchEntropy', () => {
    it('calibrates a relaxed threshold for sparse graphs to avoid frontier starvation', () => {
      // 10 nodes, 5 edges -> avgDegree = 1.0 (sparse)
      const threshold = determineAdaptiveMaxBranchEntropy({
        nodeCount: 10,
        edgeCount: 5,
        sensitivity: 'medium',
        crawlDepth: 'default',
      });
      // Normalized degree = clamp(1 - 1, 0, 5) = 0 -> densityBase = 0.72
      expect(threshold).toBe(0.72);
    });

    it('calibrates a tight threshold for dense graphs to prevent runaway branch explosion', () => {
      // 10 nodes, 30 edges -> avgDegree = 6.0 (dense)
      const threshold = determineAdaptiveMaxBranchEntropy({
        nodeCount: 10,
        edgeCount: 30,
        sensitivity: 'medium',
        crawlDepth: 'default',
      });
      // Normalized degree = clamp(6 - 1, 0, 5) = 5 -> densityBase = 0.72 - 0.32 = 0.40
      expect(threshold).toBe(0.4);
    });

    it('modulates threshold based on search sensitivity', () => {
      const baseParams = {
        nodeCount: 20,
        edgeCount: 20, // avgDegree = 2.0 -> normalizedDegree = 1 -> base = 0.72 - 0.064 = 0.656
      };

      const highSensitivity = determineAdaptiveMaxBranchEntropy({
        ...baseParams,
        sensitivity: 'high',
      });
      const mediumSensitivity = determineAdaptiveMaxBranchEntropy({
        ...baseParams,
        sensitivity: 'medium',
      });
      const lowSensitivity = determineAdaptiveMaxBranchEntropy({
        ...baseParams,
        sensitivity: 'low',
      });

      expect(highSensitivity).toBeLessThan(mediumSensitivity);
      expect(lowSensitivity).toBeGreaterThan(mediumSensitivity);
      expect(
        Math.round((mediumSensitivity - highSensitivity) * 100) / 100,
      ).toBe(0.06);
      expect(Math.round((lowSensitivity - mediumSensitivity) * 100) / 100).toBe(
        0.06,
      );
    });

    it('modulates threshold based on crawl depth', () => {
      const baseParams = {
        nodeCount: 20,
        edgeCount: 20,
        sensitivity: 'medium' as const,
      };

      const shallow = determineAdaptiveMaxBranchEntropy({
        ...baseParams,
        crawlDepth: 'shallow',
      });
      const standard = determineAdaptiveMaxBranchEntropy({
        ...baseParams,
        crawlDepth: 'default',
      });
      const deep = determineAdaptiveMaxBranchEntropy({
        ...baseParams,
        crawlDepth: 'deep',
      });

      expect(shallow).toBeLessThan(standard);
      expect(deep).toBeGreaterThan(standard);
    });

    it('clamps output strictly within [0.30, 0.80]', () => {
      // Extreme density + high sensitivity + shallow -> bounded at 0.30
      const veryDense = determineAdaptiveMaxBranchEntropy({
        nodeCount: 5,
        edgeCount: 100,
        sensitivity: 'high',
        crawlDepth: 'shallow',
      });
      expect(veryDense).toBeGreaterThanOrEqual(0.3);

      // Extreme sparsity + low sensitivity + deep -> bounded at 0.80
      const verySparse = determineAdaptiveMaxBranchEntropy({
        nodeCount: 100,
        edgeCount: 0,
        sensitivity: 'low',
        crawlDepth: 'deep',
      });
      expect(verySparse).toBeLessThanOrEqual(0.8);
    });
  });
});

describe('SearchService - Ingestion & Bootstrap', () => {
  let service: SearchService;
  let mockDb: Partial<DatabaseService>;
  let mockEmbeddings: Partial<EmbeddingService>;
  let mockRerank: Partial<RerankService>;
  let mockWeaviate: Partial<WeaviateService>;
  let mockGraphs: Partial<GraphsService>;

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
    };
    mockEmbeddings = {
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };
    mockRerank = {
      isConfigured: jest.fn().mockReturnValue(true),
      rerank: jest.fn().mockResolvedValue(undefined),
    };
    mockWeaviate = {
      isReady: jest.fn().mockResolvedValue(true),
      upsertBatch: jest.fn().mockResolvedValue(4),
    };
    mockGraphs = {
      findAccessible: jest.fn().mockResolvedValue({ id: 'graph-1' }),
    };

    service = new SearchService(
      mockDb as DatabaseService,
      mockEmbeddings as EmbeddingService,
      mockRerank as RerankService,
      mockWeaviate as WeaviateService,
      mockGraphs as GraphsService,
      { requireIdentity: jest.fn() } as unknown as AuthService,
      { assertCan: jest.fn() } as unknown as AuthorizationService,
    );
  });

  it('indexes graph sources into Weaviate with chunking and embeddings', async () => {
    (mockDb.query as jest.Mock).mockResolvedValue([
      {
        id: 'source-1',
        nodeId: 'node-1',
        name: 'Syllabus.pdf',
        content: '# Syllabus\n\nModule 1 details.\n\nModule 2 details.',
      },
    ]);

    const result = await service.indexGraphSources('graph-1');

    expect(result.sourceCount).toBe(1);
    expect(result.indexedChunks).toBe(4);
    expect(mockEmbeddings.embed).toHaveBeenCalled();
    expect(mockWeaviate.upsertBatch).toHaveBeenCalled();
  });

  it('auto-warms initial system graphs on application bootstrap when Weaviate is ready', async () => {
    (mockDb.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('SELECT "id" FROM "Graph"')) {
        return Promise.resolve([
          { id: 'system-medicine' },
          { id: 'system-computer-science' },
        ]);
      }
      return Promise.resolve([
        {
          id: 'source-1',
          nodeId: 'node-1',
          name: 'Notes.md',
          content: 'Some lecture notes content.',
        },
      ]);
    });

    await service.onApplicationBootstrap();

    expect(mockWeaviate.isReady).toHaveBeenCalled();
    expect(mockWeaviate.upsertBatch).toHaveBeenCalledTimes(2);
  });
});

describe('SearchService - Topological Crawl Query Engine', () => {
  let service: SearchService;
  let mockDb: Partial<DatabaseService>;
  let mockEmbeddings: Partial<EmbeddingService>;
  let mockRerank: Partial<RerankService>;
  let mockWeaviate: Partial<WeaviateService>;
  let mockGraphs: Partial<GraphsService>;
  let mockAuth: Partial<AuthService>;
  let mockAuthorization: Partial<AuthorizationService>;

  beforeEach(() => {
    mockDb = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO "Query"')) {
          return Promise.resolve([{ id: 'crawl-query-456' }]);
        }
        return Promise.resolve([]);
      }),
    };
    mockEmbeddings = {
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };
    mockRerank = {
      isConfigured: jest.fn().mockReturnValue(true),
      rerank: jest.fn().mockImplementation((_query, texts) => {
        return Promise.resolve(
          texts.map((_: string, idx: number) => ({
            index: idx,
            score: 0.85 - idx * 0.1,
          })),
        );
      }),
    };
    mockWeaviate = {
      isReady: jest.fn().mockResolvedValue(true),
      hybridSearch: jest.fn().mockResolvedValue([
        {
          graphId: 'graph-1',
          sourceId: 'src-1',
          sourceName: 'Seed.md',
          nodeId: 'node-start',
          content: 'Starting topic foundational definitions.',
          context: 'Seed context',
          startChar: 0,
          endChar: 40,
          pageNum: 1,
          score: 0.88,
          vector: [0.1, 0.2, 0.3],
        },
      ]),
      vectorSearch: jest.fn().mockResolvedValue([
        {
          graphId: 'graph-1',
          sourceId: 'src-2',
          sourceName: 'Hop1.md',
          nodeId: 'node-step1',
          content: 'Detailed explanation of algorithms at step 1.',
          context: 'Hop 1 context',
          startChar: 0,
          endChar: 45,
          pageNum: 1,
          score: 0.82,
          vector: [0.15, 0.25, 0.35],
        },
      ]),
      multiVectorSearch: jest
        .fn()
        .mockImplementation(
          async (graphId: string, queries: any[], tier?: any) => {
            const map = new Map<string, any[]>();
            for (const q of queries) {
              const hits = await (mockWeaviate.vectorSearch as Function)(
                graphId,
                q.vector,
                q.adjacentNodeIds,
                q.limit,
                q.minScore,
                tier,
              );
              map.set(q.id, hits);
            }
            return map;
          },
        ),
    };
    mockGraphs = {
      findAccessible: jest.fn().mockResolvedValue({
        id: 'graph-1',
        userId: 'user-1',
        nodes: [
          { id: 'node-start', data: { title: 'Starting Topic' } },
          { id: 'node-step1', data: { title: 'Intermediate Step' } },
          { id: 'node-step2', data: { title: 'Final Conclusion' } },
        ],
        edges: [
          { id: 'e1', source: 'node-start', target: 'node-step1' },
          { id: 'e2', source: 'node-step1', target: 'node-step2' },
        ],
      }),
      isAttached: jest.fn().mockResolvedValue(true),
    };
    mockAuth = {
      requireIdentity: jest.fn().mockReturnValue({
        userId: 'user-1',
        tier: 'REGISTERED',
        email: 'user@test.com',
        username: 'testuser',
        isGuest: false,
      }),
      requireRegistered: jest.fn().mockImplementation((identity) => identity),
      consumeQueryQuota: jest.fn().mockResolvedValue({ remaining: 98 }),
    };
    mockAuthorization = {
      assertCan: jest.fn(),
    };

    service = new SearchService(
      mockDb as DatabaseService,
      mockEmbeddings as EmbeddingService,
      mockRerank as RerankService,
      mockWeaviate as WeaviateService,
      mockGraphs as GraphsService,
      mockAuth as AuthService,
      mockAuthorization as AuthorizationService,
    );
  });

  it('rejects crawl request when no starting nodes are specified', async () => {
    await expect(
      service.crawl(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        { graphId: 'graph-1', query: 'test crawl', startingNodeIds: [] },
      ),
    ).rejects.toThrow(
      'Select at least one starting node from the active graph.',
    );
  });

  it('performs multi-hop crawl along directed edges and builds narrative graph', async () => {
    (mockWeaviate.vectorSearch as jest.Mock)
      .mockResolvedValueOnce([
        {
          graphId: 'graph-1',
          sourceId: 'src-2',
          sourceName: 'Step1.md',
          nodeId: 'node-step1',
          content: 'Intermediate step content.',
          context: 'Context 1',
          startChar: 0,
          endChar: 25,
          pageNum: 1,
          score: 0.85,
          vector: [0.2, 0.3, 0.4],
        },
      ])
      .mockResolvedValueOnce([
        {
          graphId: 'graph-1',
          sourceId: 'src-3',
          sourceName: 'Step2.md',
          nodeId: 'node-step2',
          content: 'Final conclusion content.',
          context: 'Context 2',
          startChar: 0,
          endChar: 25,
          pageNum: 1,
          score: 0.78,
          vector: [0.3, 0.4, 0.5],
        },
      ]);

    const crawlResponse = await service.crawl(
      {
        userId: 'user-1',
        tier: 'REGISTERED',
        email: 'user@test.com',
        username: 'testuser',
        isGuest: false,
      },
      {
        graphId: 'graph-1',
        query: 'how to complete task',
        startingNodeIds: ['node-start'],
        direction: 'forward',
        crawlDepth: 'default', // 3 levels (0, 1, 2)
      },
    );

    expect(crawlResponse.queryType).toBe('crawl');
    expect(crawlResponse.queryId).toBe('crawl-query-456');
    expect(crawlResponse.nodes.length).toBe(3);
    expect(crawlResponse.edges.length).toBe(2);

    // Level 0: starting node
    expect(crawlResponse.nodes[0]!.level).toBe(0);
    expect(crawlResponse.nodes[0]!.nodeId).toBe('node-start');

    // Level 1: node-step1
    expect(crawlResponse.nodes[1]!.level).toBe(1);
    expect(crawlResponse.nodes[1]!.nodeId).toBe('node-step1');
    expect(crawlResponse.edges[0]!.source).toBe(crawlResponse.nodes[0]!.id);
    expect(crawlResponse.edges[0]!.target).toBe(crawlResponse.nodes[1]!.id);
    expect(crawlResponse.edges[0]!.similarityScore).toBeDefined();
    expect(typeof crawlResponse.edges[0]!.similarityScore).toBe('number');

    // Level 2: node-step2
    expect(crawlResponse.nodes[2]!.level).toBe(2);
    expect(crawlResponse.nodes[2]!.nodeId).toBe('node-step2');
    expect(crawlResponse.edges[1]!.source).toBe(crawlResponse.nodes[1]!.id);
    expect(crawlResponse.edges[1]!.target).toBe(crawlResponse.nodes[2]!.id);
    expect(crawlResponse.edges[1]!.similarityScore).toBeDefined();
    expect(typeof crawlResponse.edges[1]!.similarityScore).toBe('number');

    expect(crawlResponse.maxLevelReached).toBe(2);
    expect(crawlResponse.matchedNodeIds).toEqual(
      expect.arrayContaining(['node-start', 'node-step1', 'node-step2']),
    );
  });

  it('terminates crawl branch early when candidate neighbors are exhausted or yield no matches', async () => {
    (mockWeaviate.vectorSearch as jest.Mock).mockResolvedValueOnce([]);

    const crawlResponse = await service.crawl(
      {
        userId: 'user-1',
        tier: 'REGISTERED',
        email: 'user@test.com',
        username: 'testuser',
        isGuest: false,
      },
      {
        graphId: 'graph-1',
        query: 'strict relevance test',
        startingNodeIds: ['node-start'],
        direction: 'forward',
        sensitivity: 'medium',
      },
    );

    // Stop condition hit: Only level 0 seed match survived
    expect(crawlResponse.nodes.length).toBe(1);
    expect(crawlResponse.nodes[0]!.level).toBe(0);
    expect(crawlResponse.edges.length).toBe(0);
  });

  it('branches exploration when multiple distinct matches are found in next hop (same node and neighbors)', async () => {
    // Return 2 distinct candidate matches for the hop from node-start
    (mockWeaviate.vectorSearch as jest.Mock).mockResolvedValueOnce([
      {
        graphId: 'graph-1',
        sourceId: 'src-1-b',
        sourceName: 'SeedFollowUp.md',
        nodeId: 'node-start', // Same node deeper match
        content: 'Secondary detail within starting topic.',
        context: 'Seed context B',
        startChar: 50,
        endChar: 95,
        pageNum: 1,
        score: 0.86,
        vector: [0.12, 0.22, 0.32],
      },
      {
        graphId: 'graph-1',
        sourceId: 'src-2',
        sourceName: 'Neighbor.md',
        nodeId: 'node-step1', // Connected neighbor match
        content: 'Branching exploration to adjacent node.',
        context: 'Neighbor context',
        startChar: 0,
        endChar: 40,
        pageNum: 2,
        score: 0.84,
        vector: [0.2, 0.3, 0.4],
      },
    ]);

    const crawlResponse = await service.crawl(
      {
        userId: 'user-1',
        tier: 'REGISTERED',
        email: 'user@test.com',
        username: 'testuser',
        isGuest: false,
      },
      {
        graphId: 'graph-1',
        query: 'branching exploration query',
        startingNodeIds: ['node-start'],
        direction: 'forward',
        crawlDepth: 'shallow', // level 0 and 1
      },
    );

    // 1 seed (level 0) + 2 branches at level 1 (one in same node, one in neighbor)
    const level0Nodes = crawlResponse.nodes.filter((n) => n.level === 0);
    const level1Nodes = crawlResponse.nodes.filter((n) => n.level === 1);

    expect(level0Nodes).toHaveLength(1);
    expect(level1Nodes).toHaveLength(2);

    // Edges connect seed to both branch nodes
    const seedId = level0Nodes[0]!.id;
    const branchEdges = crawlResponse.edges.filter((e) => e.source === seedId);
    expect(branchEdges).toHaveLength(2);

    const targetNodeIds = branchEdges.map((e) => e.target);
    expect(targetNodeIds).toContain(level1Nodes[0]!.id);
    expect(targetNodeIds).toContain(level1Nodes[1]!.id);
  });

  it('prevents cycles when graph edges contain loops', async () => {
    // Suppose edges has a cycle: start -> step1 -> start
    (mockGraphs.findAccessible as jest.Mock).mockResolvedValueOnce({
      id: 'graph-1',
      userId: 'user-1',
      nodes: [
        { id: 'node-start', data: { title: 'Starting Topic' } },
        { id: 'node-step1', data: { title: 'Looping Step' } },
      ],
      edges: [
        { id: 'e1', source: 'node-start', target: 'node-step1' },
        { id: 'e2', source: 'node-step1', target: 'node-start' }, // cycle!
      ],
    });

    const crawlResponse = await service.crawl(
      {
        userId: 'user-1',
        tier: 'REGISTERED',
        email: 'user@test.com',
        username: 'testuser',
        isGuest: false,
      },
      {
        graphId: 'graph-1',
        query: 'cycle avoidance test',
        startingNodeIds: ['node-start'],
        direction: 'forward',
        crawlDepth: 'deep',
      },
    );

    // node-start was already visited; node-step1 should not loop back to node-start
    expect(
      crawlResponse.nodes.filter((n) => n.nodeId === 'node-start'),
    ).toHaveLength(1);
  });

  it('supports unlimited crawl depth and halts when topology frontier is fully explored', async () => {
    const crawlResponse = await service.crawl(
      {
        userId: 'user-1',
        tier: 'REGISTERED',
        email: 'user@test.com',
        username: 'testuser',
        isGuest: false,
      },
      {
        graphId: 'graph-1',
        query: 'unlimited exploration',
        startingNodeIds: ['node-start'],
        direction: 'forward',
        crawlDepth: 'unlimited',
      },
    );

    expect(crawlResponse.crawlDepth).toBe('unlimited');
    expect(crawlResponse.nodes.length).toBeGreaterThanOrEqual(1);
    expect(crawlResponse.maxLevelReached).toBeLessThanOrEqual(20);
  });

  it('rejects crawl request from anonymous guests', async () => {
    (mockAuth.requireRegistered as jest.Mock).mockImplementationOnce(() => {
      throw new UnauthorizedException(
        'Create an account to access this action.',
      );
    });

    (mockAuth.requireIdentity as jest.Mock).mockReturnValueOnce({
      userId: 'guest-1',
      tier: 'ANONYMOUS',
      email: 'guest@test.com',
      username: 'guest',
      isGuest: true,
    });

    await expect(
      service.crawl(
        {
          userId: 'guest-1',
          tier: 'ANONYMOUS',
          email: 'guest@test.com',
          username: 'guest',
          isGuest: true,
        },
        {
          graphId: 'graph-1',
          query: 'test crawl',
          startingNodeIds: ['node-start', 'node-step1'],
        },
      ),
    ).rejects.toThrow('Anonymous crawl is limited to 1 starting point.');
  });

  it('rejects deep crawl for anonymous users', async () => {
    (mockAuth.requireIdentity as jest.Mock).mockReturnValueOnce({
      userId: 'guest-1',
      tier: 'ANONYMOUS',
      email: 'guest@test.com',
      username: 'guest',
      isGuest: true,
    });

    await expect(
      service.crawl(
        {
          userId: 'guest-1',
          tier: 'ANONYMOUS',
          email: 'guest@test.com',
          username: 'guest',
          isGuest: true,
        },
        {
          graphId: 'graph-1',
          query: 'test crawl',
          startingNodeIds: ['node-start'],
          crawlDepth: 'deep',
        },
      ),
    ).rejects.toThrow('Anonymous crawl is limited to shallow crawl depth.');
  });

  it('rejects comparative crawl for anonymous users', async () => {
    (mockAuth.requireIdentity as jest.Mock).mockReturnValueOnce({
      userId: 'guest-1',
      tier: 'ANONYMOUS',
      email: 'guest@test.com',
      username: 'guest',
      isGuest: true,
    });

    await expect(
      service.crawl(
        {
          userId: 'guest-1',
          tier: 'ANONYMOUS',
          email: 'guest@test.com',
          username: 'guest',
          isGuest: true,
        },
        {
          graphId: 'graph-1',
          query: 'test crawl',
          startingNodeIds: ['node-start'],
          comparativeMode: true,
          crawlDepth: 'shallow',
        },
      ),
    ).rejects.toThrow(
      'Comparative hypothesis crawl requires a registered account.',
    );
  });

  it('rejects comparative crawl with more than 4 hypothesis groups for registered accounts', async () => {
    (mockAuth.requireIdentity as jest.Mock).mockReturnValueOnce({
      userId: 'reg-user',
      tier: 'REGISTERED',
      email: 'reg@test.com',
      username: 'reguser',
      isGuest: false,
    });

    await expect(
      service.crawl(
        {
          userId: 'reg-user',
          tier: 'REGISTERED',
          email: 'reg@test.com',
          username: 'reguser',
          isGuest: false,
        },
        {
          graphId: 'graph-1',
          query: 'test crawl',
          startingNodeIds: ['node-start', 'node-step1'],
          comparativeMode: true,
          crawlDepth: 'shallow',
          hypothesisGroups: [
            { id: 'g1', name: 'G1', color: '#fff', nodeIds: ['node-start'] },
            { id: 'g2', name: 'G2', color: '#fff', nodeIds: ['node-step1'] },
            { id: 'g3', name: 'G3', color: '#fff', nodeIds: ['node-start'] },
            { id: 'g4', name: 'G4', color: '#fff', nodeIds: ['node-step1'] },
            { id: 'g5', name: 'G5', color: '#fff', nodeIds: ['node-start'] },
          ],
        },
      ),
    ).rejects.toThrow(
      'Comparative hypothesis crawl supports up to 4 hypothesis groups.',
    );
  });
});

describe('determineAnswerType', () => {
  const baseChunk: SearchChunk = {
    graphId: 'graph-1',
    sourceId: 'src-1',
    sourceName: 'doc.md',
    nodeId: 'node-1',
    content: 'plain text',
    context: 'plain text',
    startChar: 0,
    endChar: 10,
    pageNum: 1,
    score: 1,
  };

  it('detects tabular chunks', () => {
    expect(determineAnswerType({ ...baseChunk, elementType: 'table' })).toBe(
      'tabular',
    );
    expect(
      determineAnswerType({
        ...baseChunk,
        content: '| Col A | Col B |\n|---|---|\n| 1 | 2 |',
      }),
    ).toBe('tabular');
  });

  it('detects procedural chunks with code or numbered steps', () => {
    expect(
      determineAnswerType({
        ...baseChunk,
        content: '```ts\nconst x = 10;\n```',
      }),
    ).toBe('procedural');
    expect(
      determineAnswerType({
        ...baseChunk,
        content: 'Step 1: Download package.\nStep 2: Run install.',
      }),
    ).toBe('procedural');
    expect(
      determineAnswerType({
        ...baseChunk,
        content: '1. First initialize the graph\n2. Next traverse nodes',
      }),
    ).toBe('procedural');
  });

  it('detects definitional chunks with headings or definition terminology', () => {
    expect(
      determineAnswerType({
        ...baseChunk,
        content: '# Graph Theory\nFundamental principles of vertices.',
      }),
    ).toBe('definitional');
    expect(
      determineAnswerType({
        ...baseChunk,
        content:
          'A min-heap is defined as a complete binary tree where parent is smaller.',
      }),
    ).toBe('definitional');
  });

  it('defaults to direct for general content', () => {
    expect(
      determineAnswerType({
        ...baseChunk,
        content:
          'General remarks about the course schedule and instructor office hours.',
      }),
    ).toBe('direct');
  });
});

describe('SearchService - Neural Reranking & Lead Answer Dossier', () => {
  let service: SearchService;
  let mockDb: Partial<DatabaseService>;
  let mockEmbeddings: Partial<EmbeddingService>;
  let mockRerank: Partial<RerankService>;
  let mockWeaviate: Partial<WeaviateService>;
  let mockGraphs: Partial<GraphsService>;
  let mockAuth: Partial<AuthService>;
  let mockAuthorization: Partial<AuthorizationService>;

  beforeEach(() => {
    mockDb = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO "Query"')) {
          return Promise.resolve([{ id: 'query-123' }]);
        }
        return Promise.resolve([
          {
            id: 'src-1',
            nodeId: 'node-dijkstra',
            name: 'Algorithms.md',
            content:
              'Dijkstra algorithm uses min-heap priority queue.\n\n```python\ndef dijkstra(): pass\n```',
          },
          {
            id: 'src-2',
            nodeId: 'node-bfs',
            name: 'BFS.md',
            content: 'BFS is an unweighted shortest path search.',
          },
        ]);
      }),
    };
    mockEmbeddings = {
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };
    mockRerank = {
      isConfigured: jest.fn().mockReturnValue(true),
      rerank: jest.fn().mockResolvedValue([
        { index: 0, score: 0.96 },
        { index: 1, score: 0.32 },
      ]),
    };
    mockWeaviate = {
      isReady: jest.fn().mockResolvedValue(true),
      hybridSearch: jest.fn().mockResolvedValue([
        {
          graphId: 'graph-1',
          sourceId: 'src-2',
          sourceName: 'BFS.md',
          nodeId: 'node-bfs',
          content: 'BFS is an unweighted shortest path search.',
          context: 'BFS context',
          startChar: 0,
          endChar: 40,
          pageNum: 1,
          score: 0.7,
        },
        {
          graphId: 'graph-1',
          sourceId: 'src-1',
          sourceName: 'Algorithms.md',
          nodeId: 'node-dijkstra',
          content: 'Step 1: Initialize min-heap.\nStep 2: Relax edges.',
          context: 'Dijkstra context',
          startChar: 0,
          endChar: 55,
          pageNum: 4,
          score: 0.65,
        },
      ]),
      vectorSearch: jest.fn().mockResolvedValue([]),
      multiVectorSearch: jest
        .fn()
        .mockImplementation(
          async (graphId: string, queries: any[], tier?: any) => {
            const map = new Map<string, any[]>();
            for (const q of queries) {
              const hits = await (mockWeaviate.vectorSearch as Function)(
                graphId,
                q.vector,
                q.adjacentNodeIds,
                q.limit,
                q.minScore,
                tier,
              );
              map.set(q.id, hits);
            }
            return map;
          },
        ),
    };
    mockGraphs = {
      findAccessible: jest.fn().mockResolvedValue({
        id: 'graph-1',
        userId: 'user-1',
        nodes: [
          { id: 'node-heap', data: { title: 'Min-Heap Priority Queue' } },
          { id: 'node-dijkstra', data: { title: 'Dijkstra Algorithm' } },
          { id: 'node-astar', data: { title: 'A* Search' } },
          { id: 'node-bfs', data: { title: 'Breadth-First Search' } },
        ],
        edges: [
          { id: 'e1', source: 'node-heap', target: 'node-dijkstra' }, // Prerequisite to Dijkstra
          { id: 'e2', source: 'node-dijkstra', target: 'node-astar' }, // Extension from Dijkstra
        ],
      }),
      isAttached: jest.fn().mockResolvedValue(true),
    };
    mockAuth = {
      requireIdentity: jest.fn().mockReturnValue({
        userId: 'user-1',
        tier: 'REGISTERED',
        email: 'user@test.com',
        username: 'testuser',
        isGuest: false,
      }),
      requireRegistered: jest.fn().mockImplementation((identity) => identity),
      consumeQueryQuota: jest.fn().mockResolvedValue({ remaining: 99 }),
    };
    mockAuthorization = {
      assertCan: jest.fn(),
    };

    service = new SearchService(
      mockDb as DatabaseService,
      mockEmbeddings as EmbeddingService,
      mockRerank as RerankService,
      mockWeaviate as WeaviateService,
      mockGraphs as GraphsService,
      mockAuth as AuthService,
      mockAuthorization as AuthorizationService,
    );
  });

  it('reranks retrieved candidates via TEI and constructs LeadAnswer dossier with graph prerequisites', async () => {
    // When TEI rerank scores Dijkstra as 0.96 (index 1 in weaviate results) and BFS as 0.32 (index 0)
    (mockRerank.rerank as jest.Mock).mockResolvedValueOnce([
      { index: 1, score: 0.96 },
      { index: 0, score: 0.32 },
    ]);

    const response = await service.search(
      {
        userId: 'user-1',
        tier: 'REGISTERED',
        email: 'user@test.com',
        username: 'testuser',
        isGuest: false,
      },
      {
        graphId: 'graph-1',
        query: 'how to find shortest paths with edge weights',
      },
    );

    expect(mockRerank.rerank).toHaveBeenCalledWith(
      'how to find shortest paths with edge weights',
      expect.any(Array),
    );

    expect(response.leadAnswer).toBeDefined();
    expect(response.leadAnswer?.chunk.nodeId).toBe('node-dijkstra');
    expect(response.leadAnswer?.score).toBe(0.96);
    expect(response.leadAnswer?.answerType).toBe('procedural');

    // Graph topology: node-heap points to node-dijkstra (prerequisite)
    expect(response.leadAnswer?.prerequisiteNodes).toEqual([
      { id: 'node-heap', title: 'Min-Heap Priority Queue' },
    ]);
    // Graph topology: node-dijkstra points to node-astar (extension)
    expect(response.leadAnswer?.extensionNodes).toEqual([
      { id: 'node-astar', title: 'A* Search' },
    ]);
  });

  it('gracefully continues search when TEI reranker is unreachable', async () => {
    (mockRerank.rerank as jest.Mock).mockResolvedValueOnce(undefined);

    const response = await service.search(
      {
        userId: 'user-1',
        tier: 'REGISTERED',
        email: 'user@test.com',
        username: 'testuser',
        isGuest: false,
      },
      {
        graphId: 'graph-1',
        query: 'breadth-first search',
      },
    );

    expect(response.queryId).toBe('query-123');
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.leadAnswer).toBeDefined();
  });

  it('throws ForbiddenException when querying a non-owned graph without being attached', async () => {
    (mockGraphs.findAccessible as jest.Mock).mockResolvedValueOnce({
      id: 'graph-other',
      userId: 'user-other',
      isPublic: true,
      isPrepared: false,
      nodes: [{ id: 'node-1', data: { title: 'Node 1' } }],
      edges: [],
    });
    (mockGraphs.isAttached as jest.Mock).mockResolvedValueOnce(false);

    await expect(
      service.search(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        {
          graphId: 'graph-other',
          query: 'test query',
        },
      ),
    ).rejects.toThrow('Please attach to this graph to enable querying.');
  });

  it('retains all retrieved candidates ranked by score without dropping below threshold in similarity search', async () => {
    (mockRerank.rerank as jest.Mock).mockResolvedValueOnce([
      { index: 0, score: 0.45 },
      { index: 1, score: 0.3 },
    ]);

    const response = await service.search(
      {
        userId: 'user-1',
        tier: 'REGISTERED',
        email: 'user@test.com',
        username: 'testuser',
        isGuest: false,
      },
      {
        graphId: 'graph-1',
        query: 'niche topic with weak matches',
        sensitivity: 'high',
      },
    );

    expect(response.results.length).toBeGreaterThan(0);
    expect(response.matchedNodeIds.length).toBeGreaterThan(0);
    expect(response.leadAnswer).toBeDefined();
  });
  it('throws BadRequestException when query is omitted or empty', async () => {
    await expect(
      service.search(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        {
          graphId: 'graph-1',
          query: '   ',
        },
      ),
    ).rejects.toThrow('Provide a query text to search.');
  });

  it('expands acronyms for hybrid search BM25 while keeping raw query for dense embedding', async () => {
    const response = await service.search(
      {
        userId: 'user-1',
        tier: 'REGISTERED',
        email: 'user@test.com',
        username: 'testuser',
        isGuest: false,
      },
      {
        graphId: 'graph-1',
        query: 'k8s pods',
      },
    );

    expect(response.query).toBe('k8s pods');
    expect(response.expandedKeywords).toContain('kubernetes');

    // Dense embedding should receive the exact raw query
    expect(mockEmbeddings.embed).toHaveBeenCalledWith('k8s pods');

    // Weaviate hybridSearch should receive the expanded BM25 query
    expect(mockWeaviate.hybridSearch).toHaveBeenCalledWith(
      'graph-1',
      'k8s pods kubernetes',
      expect.any(Array),
      expect.any(Array),
      expect.any(Number),
      expect.any(Number),
      expect.any(String),
    );
  });

  describe('LRU Topological Caching & Multi-Seed Comparative Crawling', () => {
    it('caches and reuses topological depth metrics across identical queries', async () => {
      const nodes = [
        { id: 'n1', data: { title: 'Node 1' } },
        { id: 'n2', data: { title: 'Node 2' } },
      ];
      const edges = [{ id: 'e1', source: 'n1', target: 'n2' }];
      const date = new Date('2026-01-01T00:00:00Z');

      const res1 = await service.getCachedGraphDepthMetrics(
        'graph-1',
        date,
        nodes,
        edges,
        ['n1'],
        'forward',
      );
      const res2 = await service.getCachedGraphDepthMetrics(
        'graph-1',
        date,
        nodes,
        edges,
        ['n1'],
        'forward',
      );

      expect(res1).toEqual(res2);
      expect(res1.maxReachableHops).toBe(1);

      // Invalidation when updatedAt changes
      const dateUpdated = new Date('2026-02-01T00:00:00Z');
      const res3 = await service.getCachedGraphDepthMetrics(
        'graph-1',
        dateUpdated,
        nodes,
        edges,
        ['n1'],
        'forward',
      );
      expect(res3).toEqual(res1);
    });

    it('interacts with Redis client for caching when RedisService is configured', async () => {
      const mockRedisService = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        publish: jest.fn().mockResolvedValue(1),
      } as unknown as RedisService;

      const customService = new SearchService(
        mockDb as DatabaseService,
        mockEmbeddings as EmbeddingService,
        mockRerank as RerankService,
        mockWeaviate as WeaviateService,
        mockGraphs as GraphsService,
        mockAuth as AuthService,
        mockAuthorization as AuthorizationService,
        mockRedisService,
      );

      const nodes = [{ id: 'n1', data: { title: 'Node 1' } }];
      const edges: any[] = [];
      const date = new Date('2026-01-01T00:00:00Z');

      const computed = await customService.getCachedGraphDepthMetrics(
        'graph-redis',
        date,
        nodes,
        edges,
        ['n1'],
        'forward',
      );

      expect(mockRedisService.get).toHaveBeenCalled();
      expect(mockRedisService.set).toHaveBeenCalledWith(
        expect.stringContaining('crawl:topology:graph-redis:'),
        JSON.stringify(computed),
        3600,
      );

      // Subsequent call returns from Redis
      (mockRedisService.get as jest.Mock).mockResolvedValueOnce(
        JSON.stringify(computed),
      );
      const cached = await customService.getCachedGraphDepthMetrics(
        'graph-redis-2',
        date,
        nodes,
        edges,
        ['n1'],
        'forward',
      );
      expect(cached).toEqual(computed);
    });

    it('classifies crawl matches into seed, dig, link, and jump with summary stats', async () => {
      (mockGraphs.findAccessible as jest.Mock).mockResolvedValueOnce({
        id: 'graph-crawl-types',
        userId: 'user-1',
        updatedAt: new Date(),
        nodes: [
          { id: 'node-seed', data: { title: 'Deep Learning' } },
          { id: 'node-robotics', data: { title: 'Robotics' } },
        ],
        edges: [{ id: 'e1', source: 'node-seed', target: 'node-robotics' }],
      });

      // Seed retrieval: single best match
      (mockWeaviate.hybridSearch as jest.Mock).mockResolvedValueOnce([
        {
          graphId: 'graph-crawl-types',
          sourceId: 's-seed',
          sourceName: 'DL.md',
          nodeId: 'node-seed',
          content: 'Deep learning neural networks and gradient descent.',
          score: 0.95,
          vector: [0.1, 0.2, 0.3],
        },
      ]);

      // Hop 1 vectorSearch candidates:
      (mockWeaviate.vectorSearch as jest.Mock).mockResolvedValueOnce([
        {
          graphId: 'graph-crawl-types',
          sourceId: 's-dig',
          sourceName: 'DL-details.md',
          nodeId: 'node-seed',
          content:
            'Backpropagation and multilayer perceptrons details and architecture.',
          score: 0.92,
          vector: [0.11, 0.21, 0.31],
        },
        {
          graphId: 'graph-crawl-types',
          sourceId: 's-jump',
          sourceName: 'Robotics.md',
          nodeId: 'node-robotics',
          content: 'Robotic arm kinematics, motion planning and actuators.',
          score: 0.88,
          vector: [0.2, 0.3, 0.4],
        },
      ]);

      (mockRerank.rerank as jest.Mock).mockImplementation((_query, texts) =>
        Promise.resolve(
          texts.map((_: string, idx: number) => ({
            index: idx,
            score: 0.9 - idx * 0.05,
          })),
        ),
      );

      const response = await service.crawl(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        {
          graphId: 'graph-crawl-types',
          query: 'deep learning applications',
          startingNodeIds: ['node-seed'],
          crawlDepth: 'shallow',
          enableDigs: true,
          enableLinks: true,
          enableJumps: true,
        },
      );

      expect(response.nodes[0]?.matchType).toBe('seed');
      expect(response.stats).toBeDefined();
      expect(response.totalMatches).toBeGreaterThanOrEqual(2);
      expect(
        (response.stats?.digsCount ?? 0) +
          (response.stats?.linksCount ?? 0) +
          (response.stats?.jumpsCount ?? 0),
      ).toBeGreaterThanOrEqual(1);

      // Verify edge properties
      if (response.edges.length > 0) {
        expect(['dig', 'link', 'jump']).toContain(response.edges[0]?.matchType);
      }
    });

    it('restarts dig counter when jumping to a new topic', async () => {
      const { classifyCrawlCandidate } = await import('./search.utils');

      // 1. Initial digs in current topic (reached maxDigsPerTopic)
      const digResult = classifyCrawlCandidate({
        candidateNodeId: 'node-dl',
        currentNodeId: 'node-dl',
        currentTopicTitle: 'Deep Learning',
        candidateContent: 'Detailed neural network layer configuration.',
        isAdjacentInGraph: false,
        digsInCurrentTopic: 3,
        maxDigsPerTopic: 3,
        enableDigs: true,
      });
      // Should not allow another dig when limit is reached
      expect(digResult).toBeNull();

      // 2. Traversal jumps to 'Robotics'
      const jumpResult = classifyCrawlCandidate({
        candidateNodeId: 'node-robotics',
        currentNodeId: 'node-dl',
        currentTopicTitle: 'Deep Learning',
        candidateContent: 'Robotics kinematic chain control principles.',
        isAdjacentInGraph: true,
        enableJumps: true,
        totalJumps: 0,
        maxJumps: 2,
      });
      expect(jumpResult).toBe('jump');

      // 3. After jump, dig counter restarts for 'Robotics' (digsInCurrentTopic = 0)
      const digAfterJump = classifyCrawlCandidate({
        candidateNodeId: 'node-robotics',
        currentNodeId: 'node-robotics',
        currentTopicTitle: 'Robotics',
        candidateContent: 'Actuator torque calculations and PID tuning.',
        isAdjacentInGraph: false,
        digsInCurrentTopic: 0,
        maxDigsPerTopic: 3,
        enableDigs: true,
      });
      expect(digAfterJump).toBe('dig');
    });

    it('respects enableDigs, enableLinks, and enableJumps limits', async () => {
      const { classifyCrawlCandidate } = await import('./search.utils');

      // Disabled jumps
      const jumpDisabled = classifyCrawlCandidate({
        candidateNodeId: 'node-target',
        currentNodeId: 'node-source',
        currentTopicTitle: 'Source Topic',
        candidateContent: 'Completely different topic content.',
        isAdjacentInGraph: true,
        enableJumps: false,
        enableLinks: false,
      });
      expect(jumpDisabled).toBeNull();

      // Disabled digs
      const digDisabled = classifyCrawlCandidate({
        candidateNodeId: 'node-source',
        currentNodeId: 'node-source',
        currentTopicTitle: 'Source Topic',
        candidateContent: 'Elaborating on source topic.',
        isAdjacentInGraph: false,
        enableDigs: false,
      });
      expect(digDisabled).toBeNull();

      // Link when connected topic title is mentioned
      const linkMatch = classifyCrawlCandidate({
        candidateNodeId: 'node-source',
        currentNodeId: 'node-source',
        currentTopicTitle: 'Deep Learning',
        candidateContent: 'We apply this algorithm to Computer Vision models.',
        isAdjacentInGraph: false,
        connectedTopicTitles: ['Computer Vision'],
        enableLinks: true,
        totalLinks: 0,
        maxLinks: 2,
      });
      expect(linkMatch).toBe('link');
    });

    it('classifies non-adjacent candidates using dynamic similarity gap thresholding', async () => {
      const { classifyCrawlCandidate } = await import('./search.utils');

      // 1. Non-adjacent candidate within transition band (0.35 <= sim <= 0.70) classifies as 'jump'
      const semanticJump = classifyCrawlCandidate({
        candidateNodeId: 'node-unconnected-nlp',
        currentNodeId: 'node-dl',
        currentTopicTitle: 'Deep Learning',
        candidateContent:
          'Transformers and self-attention mechanisms in language modeling.',
        isAdjacentInGraph: false,
        semanticSimilarity: 0.55,
        similarityGapThreshold: 0.7,
        minJumpSimilarity: 0.35,
        enableJumps: true,
        totalJumps: 0,
        maxJumps: 2,
      });
      expect(semanticJump).toBe('jump');

      // 2. Non-adjacent candidate with high similarity (> 0.70) acts as conceptual bridge -> 'link'
      const semanticLink = classifyCrawlCandidate({
        candidateNodeId: 'node-unconnected-dl2',
        currentNodeId: 'node-dl',
        currentTopicTitle: 'Deep Learning',
        candidateContent:
          'Backpropagation gradients and parameter updates across deep architectures.',
        isAdjacentInGraph: false,
        semanticSimilarity: 0.88,
        similarityGapThreshold: 0.7,
        minJumpSimilarity: 0.35,
        enableLinks: true,
        totalLinks: 0,
        maxLinks: 2,
      });
      expect(semanticLink).toBe('link');

      // 3. Non-adjacent candidate with low similarity (< 0.35) is pruned (returns null)
      const semanticPruned = classifyCrawlCandidate({
        candidateNodeId: 'node-unconnected-music',
        currentNodeId: 'node-dl',
        currentTopicTitle: 'Deep Learning',
        candidateContent:
          'Harmonic acoustic frequencies in classical orchestra performance.',
        isAdjacentInGraph: false,
        semanticSimilarity: 0.18,
        similarityGapThreshold: 0.7,
        minJumpSimilarity: 0.35,
        enableLinks: true,
        enableJumps: true,
      });
      expect(semanticPruned).toBeNull();
    });

    it('dynamically adapts jump similarity thresholds based on graph density and node degree', async () => {
      const { determineAdaptiveJumpThresholds, classifyCrawlCandidate } =
        await import('./search.utils');

      // 1. Sparse graph topology (avg degree <= 1) relaxes jump thresholds
      const sparseThresholds = determineAdaptiveJumpThresholds({
        nodeCount: 10,
        edgeCount: 4, // avgDegree = 0.8
        localDegree: 0,
        sensitivity: 'medium',
      });
      expect(sparseThresholds.minJumpSimilarity).toBeLessThanOrEqual(0.3);
      expect(sparseThresholds.similarityGapThreshold).toBeGreaterThanOrEqual(
        0.72,
      );

      // 2. Dense graph topology (avg degree >= 4) tightens jump thresholds
      const denseThresholds = determineAdaptiveJumpThresholds({
        nodeCount: 10,
        edgeCount: 25, // avgDegree = 5.0
        localDegree: 5,
        sensitivity: 'medium',
      });
      expect(denseThresholds.minJumpSimilarity).toBeGreaterThanOrEqual(0.4);
      expect(denseThresholds.similarityGapThreshold).toBeLessThanOrEqual(0.66);

      // 3. Sensitivity 'high' tightens minJumpSimilarity further
      const highSensThresholds = determineAdaptiveJumpThresholds({
        avgDegree: 2.5,
        sensitivity: 'high',
      });
      const lowSensThresholds = determineAdaptiveJumpThresholds({
        avgDegree: 2.5,
        sensitivity: 'low',
      });
      expect(highSensThresholds.minJumpSimilarity).toBeGreaterThan(
        lowSensThresholds.minJumpSimilarity,
      );

      // 4. Candidate with similarity 0.30 qualifies for jump in sparse graph but is pruned in dense graph
      const sparseJump = classifyCrawlCandidate({
        candidateNodeId: 'node-remote',
        currentNodeId: 'node-seed',
        currentTopicTitle: 'Compiler Design',
        candidateContent: 'Intermediate representation optimization pipelines.',
        isAdjacentInGraph: false,
        semanticSimilarity: 0.3,
        enableJumps: true,
        densityParams: {
          localDegree: 0,
          avgDegree: 0.8,
          sensitivity: 'medium',
        },
      });
      expect(sparseJump).toBe('jump');

      const denseRejected = classifyCrawlCandidate({
        candidateNodeId: 'node-remote',
        currentNodeId: 'node-seed',
        currentTopicTitle: 'Compiler Design',
        candidateContent: 'Intermediate representation optimization pipelines.',
        isAdjacentInGraph: false,
        semanticSimilarity: 0.3,
        enableJumps: true,
        densityParams: {
          localDegree: 5,
          avgDegree: 5.0,
          sensitivity: 'medium',
        },
      });
      expect(denseRejected).toBeNull();
    });

    it('surfaces links and jumps more frequently via relaxed thresholds and token-level topic matching', async () => {
      const { classifyCrawlCandidate } = await import('./search.utils');

      // 1. Token-level matching: candidate mentioning "robotics" links to "Deep Learning in Robotics"
      const tokenLink = classifyCrawlCandidate({
        candidateNodeId: 'node-robotics-app',
        currentNodeId: 'node-dl',
        currentTopicTitle: 'Deep Learning in Robotics',
        candidateContent:
          'Autonomous navigation and kinematic control for mobile robotics platforms.',
        isAdjacentInGraph: false,
        enableLinks: true,
        totalLinks: 0,
        maxLinks: 3,
      });
      expect(tokenLink).toBe('link');

      // 2. Relaxed jump threshold: similarity of 0.30 qualifies as jump under default thresholds (was 0.35)
      const moderateJump = classifyCrawlCandidate({
        candidateNodeId: 'node-unconnected-stats',
        currentNodeId: 'node-dl',
        currentTopicTitle: 'Deep Learning',
        candidateContent:
          'Markov decision processes in reinforcement policies.',
        isAdjacentInGraph: false,
        semanticSimilarity: 0.3,
        enableJumps: true,
        totalJumps: 0,
        maxJumps: 3,
      });
      expect(moderateJump).toBe('jump');

      // 3. Calibrated gap threshold: similarity 0.66 classifies as conceptual link (threshold relaxed from 0.70 to 0.65)
      const conceptualLink = classifyCrawlCandidate({
        candidateNodeId: 'node-unconnected-conv',
        currentNodeId: 'node-dl',
        currentTopicTitle: 'Deep Learning',
        candidateContent: 'Feature maps in visual representations.',
        isAdjacentInGraph: false,
        semanticSimilarity: 0.66,
        enableLinks: true,
        totalLinks: 0,
        maxLinks: 3,
      });
      expect(conceptualLink).toBe('link');
    });

    it('takes all relevant matches up to maxCandidatesPerStep in subsequent crawl steps', async () => {
      (mockGraphs.findAccessible as jest.Mock).mockResolvedValueOnce({
        id: 'graph-multi-candidates',
        userId: 'user-1',
        updatedAt: new Date(),
        nodes: [
          { id: 'node-seed', data: { title: 'Machine Learning' } },
          { id: 'node-hop1', data: { title: 'Supervised Learning' } },
          { id: 'node-hop2', data: { title: 'Unsupervised Learning' } },
        ],
        edges: [
          { id: 'e1', source: 'node-seed', target: 'node-hop1' },
          { id: 'e2', source: 'node-seed', target: 'node-hop2' },
        ],
      });

      (mockWeaviate.hybridSearch as jest.Mock).mockResolvedValueOnce([
        {
          graphId: 'graph-multi-candidates',
          sourceId: 's-seed',
          sourceName: 'ML.md',
          nodeId: 'node-seed',
          content: 'Machine learning fundamentals and concepts.',
          score: 0.95,
          vector: [0.1, 0.2, 0.3],
        },
      ]);

      (mockWeaviate.vectorSearch as jest.Mock).mockResolvedValueOnce([
        {
          graphId: 'graph-multi-candidates',
          sourceId: 's-hop1',
          sourceName: 'Supervised.md',
          nodeId: 'node-hop1',
          content: 'Supervised learning with labeled datasets and regression.',
          score: 0.88,
          vector: [0.2, 0.3, 0.4],
        },
        {
          graphId: 'graph-multi-candidates',
          sourceId: 's-hop2',
          sourceName: 'Unsupervised.md',
          nodeId: 'node-hop2',
          content:
            'Unsupervised learning with clustering and dimensionality reduction.',
          score: 0.85,
          vector: [0.25, 0.35, 0.45],
        },
      ]);

      (mockWeaviate.vectorSearch as jest.Mock).mockResolvedValue([]);

      const response = await service.crawl(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        {
          graphId: 'graph-multi-candidates',
          query: 'machine learning algorithms',
          startingNodeIds: ['node-seed'],
          maxCandidatesPerStep: 3,
          maxDigsPerTopic: 3,
          maxLinks: 2,
          maxJumps: 2,
        },
      );

      expect(response.nodes[0]!.matchType).toBe('seed');
      expect(response.nodes.length).toBeGreaterThanOrEqual(3);
      const level1Nodes = response.nodes.filter((n) => n.level === 1);
      expect(level1Nodes.length).toBe(2);
      expect(level1Nodes.map((n) => n.nodeId)).toContain('node-hop1');
      expect(level1Nodes.map((n) => n.nodeId)).toContain('node-hop2');
    });

    it('executes batched Weaviate multiVectorSearch across active branches in a single call', async () => {
      (mockGraphs.findAccessible as jest.Mock).mockResolvedValueOnce({
        id: 'graph-batch-weaviate',
        userId: 'user-1',
        updatedAt: new Date(),
        nodes: [
          { id: 'node-seed', data: { title: 'Seed Topic' } },
          { id: 'node-b1', data: { title: 'Branch 1' } },
          { id: 'node-b2', data: { title: 'Branch 2' } },
        ],
        edges: [
          { id: 'e1', source: 'node-seed', target: 'node-b1' },
          { id: 'e2', source: 'node-seed', target: 'node-b2' },
        ],
      });

      (mockWeaviate.hybridSearch as jest.Mock).mockResolvedValueOnce([
        {
          graphId: 'graph-batch-weaviate',
          sourceId: 's-seed',
          sourceName: 'Seed.md',
          nodeId: 'node-seed',
          content: 'Initial seed concept and overview.',
          score: 0.95,
          vector: [0.1, 0.2, 0.3],
        },
      ]);

      (mockWeaviate.multiVectorSearch as jest.Mock).mockImplementationOnce(
        async (_graphId: string, queries: any[]) => {
          const map = new Map<string, any[]>();
          for (const q of queries) {
            map.set(q.id, [
              {
                graphId: 'graph-batch-weaviate',
                sourceId: 's-1',
                sourceName: 'B1.md',
                nodeId: 'node-b1',
                content: 'Branch 1 detailed implementation notes.',
                score: 0.88,
                vector: [0.2, 0.3, 0.4],
              },
              {
                graphId: 'graph-batch-weaviate',
                sourceId: 's-2',
                sourceName: 'B2.md',
                nodeId: 'node-b2',
                content: 'Branch 2 detailed implementation notes.',
                score: 0.85,
                vector: [0.25, 0.35, 0.45],
              },
            ]);
          }
          return map;
        },
      );

      // Subsequent hop: 2 branches are active
      (mockWeaviate.multiVectorSearch as jest.Mock).mockImplementation(
        async (_graphId: string, queries: any[]) => {
          const map = new Map<string, any[]>();
          for (const q of queries) {
            map.set(q.id, []);
          }
          return map;
        },
      );

      const response = await service.crawl(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        {
          graphId: 'graph-batch-weaviate',
          query: 'crawl traversal',
          startingNodeIds: ['node-seed'],
          maxCandidatesPerStep: 2,
        },
      );

      expect(response.nodes.length).toBeGreaterThanOrEqual(1);
      expect(mockWeaviate.multiVectorSearch).toHaveBeenCalled();
    });

    it('suppresses duplicate chunks on same node with same matchType using MMR diversity', async () => {
      (mockGraphs.findAccessible as jest.Mock).mockResolvedValueOnce({
        id: 'graph-mmr-diversity',
        userId: 'user-1',
        updatedAt: new Date(),
        nodes: [{ id: 'node-root', data: { title: 'Deep Learning' } }],
        edges: [],
      });

      (mockWeaviate.hybridSearch as jest.Mock).mockResolvedValueOnce([
        {
          graphId: 'graph-mmr-diversity',
          sourceId: 's-root',
          sourceName: 'DL.md',
          nodeId: 'node-root',
          content: 'Deep learning core architectures.',
          score: 0.95,
          vector: [1, 0, 0],
        },
      ]);

      // Provide 3 candidates for the first dig hop:
      // cand 1: score 0.94, vector [1, 0, 0]
      // cand 2: score 0.92, vector [0.99, 0.05, 0] (sim > 0.98 with cand 1 on same node -> duplicate!)
      // cand 3: score 0.85, vector [0.1, 0.9, 0] (diverse vector)
      (mockWeaviate.multiVectorSearch as jest.Mock).mockImplementationOnce(
        async (_graphId: string, queries: any[]) => {
          const map = new Map<string, any[]>();
          for (const q of queries) {
            map.set(q.id, [
              {
                graphId: 'graph-mmr-diversity',
                sourceId: 's-1',
                sourceName: 'DL.md',
                nodeId: 'node-root',
                content: 'Neural network weight optimization techniques.',
                score: 0.94,
                vector: [1, 0, 0],
              },
              {
                graphId: 'graph-mmr-diversity',
                sourceId: 's-2',
                sourceName: 'DL.md',
                nodeId: 'node-root',
                content:
                  'Neural network weight optimization techniques duplicate.',
                score: 0.92,
                vector: [0.99, 0.05, 0],
              },
              {
                graphId: 'graph-mmr-diversity',
                sourceId: 's-3',
                sourceName: 'DL.md',
                nodeId: 'node-root',
                content:
                  'Recurrent sequence memory and LSTM gating mechanisms.',
                score: 0.85,
                vector: [0.1, 0.9, 0],
              },
            ]);
          }
          return map;
        },
      );

      (mockWeaviate.multiVectorSearch as jest.Mock).mockResolvedValue(
        new Map(),
      );

      const response = await service.crawl(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        {
          graphId: 'graph-mmr-diversity',
          query: 'neural networks',
          startingNodeIds: ['node-root'],
          maxCandidatesPerStep: 2,
          maxDigsPerTopic: 3,
        },
      );

      const level1Nodes = response.nodes.filter((n) => n.level === 1);
      expect(level1Nodes.length).toBe(2);
      expect(level1Nodes[0]?.chunk.content).toContain(
        'Neural network weight optimization',
      );
      // The duplicate chunk should have been suppressed by MMR diversity in favor of the diverse LSTM chunk
      expect(level1Nodes.map((n) => n.chunk.content)).not.toContain(
        'Neural network weight optimization techniques duplicate.',
      );
      expect(level1Nodes.map((n) => n.chunk.content)).toContain(
        'Recurrent sequence memory and LSTM gating mechanisms.',
      );
    });

    it('prunes redundant parallel branches converging to same node with high similarity and same match type', async () => {
      (mockGraphs.findAccessible as jest.Mock).mockResolvedValueOnce({
        id: 'graph-beam-pruning',
        userId: 'user-1',
        updatedAt: new Date(),
        nodes: [
          { id: 'node-root', data: { title: 'Root Topic' } },
          { id: 'node-a', data: { title: 'Topic A' } },
          { id: 'node-b', data: { title: 'Topic B' } },
          { id: 'node-dest', data: { title: 'Destination Topic' } },
        ],
        edges: [
          { id: 'e1', source: 'node-root', target: 'node-a' },
          { id: 'e2', source: 'node-root', target: 'node-b' },
          { id: 'e3', source: 'node-a', target: 'node-dest' },
          { id: 'e4', source: 'node-b', target: 'node-dest' },
        ],
      });

      (mockWeaviate.hybridSearch as jest.Mock).mockResolvedValueOnce([
        {
          graphId: 'graph-beam-pruning',
          sourceId: 's-root',
          sourceName: 'Root.md',
          nodeId: 'node-root',
          content: 'Root concepts.',
          score: 0.95,
          vector: [0.1, 0.2, 0.3],
        },
      ]);

      let callCount = 0;
      (mockWeaviate.multiVectorSearch as jest.Mock).mockImplementation(
        async (_graphId: string, queries: any[]) => {
          callCount++;
          const map = new Map<string, any[]>();
          if (callCount === 1) {
            // Level 1: 1 query from root -> returns topic A and topic B
            for (const q of queries) {
              map.set(q.id, [
                {
                  graphId: 'graph-beam-pruning',
                  sourceId: 's-a',
                  sourceName: 'A.md',
                  nodeId: 'node-a',
                  content: 'Branch A exploration.',
                  score: 0.9,
                  vector: [1, 0, 0],
                },
                {
                  graphId: 'graph-beam-pruning',
                  sourceId: 's-b',
                  sourceName: 'B.md',
                  nodeId: 'node-b',
                  content: 'Branch B exploration.',
                  score: 0.88,
                  vector: [0, 1, 0],
                },
              ]);
            }
          } else {
            // Level 2: active branches are A and B
            for (const q of queries) {
              map.set(q.id, []);
            }
          }
          return map;
        },
      );

      const response = await service.crawl(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        {
          graphId: 'graph-beam-pruning',
          query: 'testing beam pruning',
          startingNodeIds: ['node-root'],
          maxCandidatesPerStep: 2,
        },
      );

      expect(response.nodes.length).toBeGreaterThanOrEqual(1);
    });

    it('supports cancelling active crawl and returning partial results early', async () => {
      (mockGraphs.findAccessible as jest.Mock).mockResolvedValueOnce({
        id: 'graph-cancel',
        userId: 'user-1',
        updatedAt: new Date(),
        nodes: [
          { id: 'node-c1', data: { title: 'Seed 1' } },
          { id: 'node-c2', data: { title: 'Hop 1 Node' } },
        ],
        edges: [{ id: 'e1', source: 'node-c1', target: 'node-c2' }],
      });

      (mockWeaviate.hybridSearch as jest.Mock).mockResolvedValueOnce([
        {
          graphId: 'graph-cancel',
          sourceId: 's-1',
          sourceName: 'Seed.md',
          nodeId: 'node-c1',
          content: 'Details on seed node 1.',
          score: 0.95,
          vector: [0.1, 0.2, 0.3],
        },
      ]);

      const crawlPromise = service.crawl(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        {
          jobId: 'test-job-cancel-123',
          graphId: 'graph-cancel',
          query: 'operating system scheduling and memory',
          startingNodeIds: ['node-c1'],
          crawlDepth: 'default',
        },
      );

      // Trigger cancel on the active job
      const cancelResult = await service.cancelCrawl(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        'test-job-cancel-123',
      );

      expect(cancelResult.cancelled).toBe(true);
      expect(cancelResult.jobId).toBe('test-job-cancel-123');

      const response = await crawlPromise;
      expect(response).toBeDefined();
      expect(response.jobId).toBe('test-job-cancel-123');
      expect(response.nodes.length).toBeGreaterThan(0);
    });

    it('executes multi-seed comparative crawl with Group A and Group B, detecting intersections', async () => {
      (mockGraphs.findAccessible as jest.Mock).mockResolvedValueOnce({
        id: 'graph-comp',
        userId: 'user-1',
        updatedAt: new Date(),
        nodes: [
          { id: 'node-a', data: { title: 'Hypothesis A Start' } },
          { id: 'node-b', data: { title: 'Hypothesis B Start' } },
          { id: 'node-shared', data: { title: 'Convergence Point' } },
        ],
        edges: [
          { id: 'e1', source: 'node-a', target: 'node-shared' },
          { id: 'e2', source: 'node-b', target: 'node-shared' },
        ],
      });

      // Retrieval mock for Step 0 and subsequent hops
      (mockWeaviate.hybridSearch as jest.Mock).mockImplementation(
        async (_graphId, _query, nodeIds) => {
          if (nodeIds.includes('node-a')) {
            return [
              {
                graphId: 'graph-comp',
                sourceId: 's-a',
                sourceName: 'A.md',
                nodeId: 'node-a',
                content: 'Hypothesis A explores deterministic methods.',
                score: 0.92,
                vector: [1.0, 0.0, 0.0],
              },
            ];
          }
          if (nodeIds.includes('node-b')) {
            return [
              {
                graphId: 'graph-comp',
                sourceId: 's-b',
                sourceName: 'B.md',
                nodeId: 'node-b',
                content: 'Hypothesis B explores stochastic algorithms.',
                score: 0.88,
                vector: [0.0, 1.0, 0.0],
              },
            ];
          }
          return [];
        },
      );

      (mockWeaviate.vectorSearch as jest.Mock).mockImplementation(
        async (_graphId, _vector, targetNodeIds) => {
          if (targetNodeIds.includes('node-shared')) {
            return [
              {
                graphId: 'graph-comp',
                sourceId: 's-shared',
                sourceName: 'Shared.md',
                nodeId: 'node-shared',
                content:
                  'Convergence where deterministic meets stochastic models.',
                score: 0.85,
                vector: [0.7, 0.7, 0.0],
              },
            ];
          }
          return [];
        },
      );

      (mockRerank.rerank as jest.Mock).mockImplementation((_query, texts) =>
        Promise.resolve(
          texts.map((_: string, idx: number) => ({
            index: idx,
            score: 0.9 - idx * 0.05,
          })),
        ),
      );

      const response = await service.crawl(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        {
          graphId: 'graph-comp',
          query: 'deterministic vs stochastic',
          startingNodeIds: ['node-a'],
          groupBStartingNodeIds: ['node-b'],
          comparativeMode: true,
          crawlDepth: 'shallow',
          enableDigs: false,
          enableLinks: true,
          enableJumps: true,
        },
      );

      expect(response.comparative).toBeDefined();
      expect(response.comparative?.isComparative).toBe(true);
      expect(response.comparative?.groupACount).toBeGreaterThanOrEqual(1);
      expect(response.comparative?.groupBCount).toBeGreaterThanOrEqual(1);
      expect(response.comparative?.intersectionCount).toBeGreaterThanOrEqual(1);
      expect(response.comparative?.intersectionNodeTitles).toContain(
        'Convergence Point',
      );
      expect(response.comparative?.groups).toHaveLength(2);

      // Check level 0 root nodes
      const level0Nodes = response.nodes.filter((n) => n.level === 0);
      expect(level0Nodes).toHaveLength(2);
      expect(level0Nodes.some((n) => n.groupOrigin === 'groupA')).toBe(true);
      expect(level0Nodes.some((n) => n.groupOrigin === 'groupB')).toBe(true);

      // Check convergence node
      const intersectionNodes = response.nodes.filter(
        (n) => n.groupOrigin === 'intersection',
      );
      expect(intersectionNodes.length).toBeGreaterThanOrEqual(1);
      expect(intersectionNodes[0]?.nodeId).toBe('node-shared');
      expect(intersectionNodes[0]?.reachedGroupIds).toEqual(
        expect.arrayContaining(['groupA', 'groupB']),
      );
    });

    it('supports up to 4 custom hypothesis groups with distinctive metadata and centroids', async () => {
      (mockGraphs.findAccessible as jest.Mock).mockResolvedValueOnce({
        id: 'graph-multi-groups',
        userId: 'user-1',
        updatedAt: new Date(),
        nodes: [
          { id: 'node-g1', data: { title: 'Group 1 Symbolic AI' } },
          { id: 'node-g2', data: { title: 'Group 2 Connectionist AI' } },
          { id: 'node-g3', data: { title: 'Group 3 Evolutionary AI' } },
        ],
        edges: [],
      });

      (mockWeaviate.hybridSearch as jest.Mock).mockImplementation(
        async (_graphId, _query, nodeIds) => {
          if (nodeIds.includes('node-g1')) {
            return [
              {
                graphId: 'graph-multi-groups',
                sourceId: 's1',
                sourceName: 'g1.md',
                nodeId: 'node-g1',
                content: 'Symbolic rules, expert systems, and logic inference.',
                score: 0.95,
                vector: [1.0, 0.0, 0.0],
              },
            ];
          }
          if (nodeIds.includes('node-g2')) {
            return [
              {
                graphId: 'graph-multi-groups',
                sourceId: 's2',
                sourceName: 'g2.md',
                nodeId: 'node-g2',
                content: 'Deep neural networks and weight backpropagation.',
                score: 0.93,
                vector: [0.0, 1.0, 0.0],
              },
            ];
          }
          if (nodeIds.includes('node-g3')) {
            return [
              {
                graphId: 'graph-multi-groups',
                sourceId: 's3',
                sourceName: 'g3.md',
                nodeId: 'node-g3',
                content: 'Genetic algorithms and evolutionary strategies.',
                score: 0.91,
                vector: [0.0, 0.0, 1.0],
              },
            ];
          }
          return [];
        },
      );

      (mockRerank.rerank as jest.Mock).mockImplementation((_query, texts) =>
        Promise.resolve(
          texts.map((_: string, idx: number) => ({
            index: idx,
            score: 0.9 - idx * 0.05,
          })),
        ),
      );

      const response = await service.crawl(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        {
          graphId: 'graph-multi-groups',
          query: 'AI paradigms',
          startingNodeIds: ['node-g1', 'node-g2', 'node-g3'],
          comparativeMode: true,
          hypothesisGroups: [
            {
              id: 'symbolic',
              name: 'Symbolic',
              nodeIds: ['node-g1'],
              color: '#3b82f6',
            },
            {
              id: 'connectionist',
              name: 'Connectionist',
              nodeIds: ['node-g2'],
              color: '#ef4444',
            },
            {
              id: 'evolutionary',
              name: 'Evolutionary',
              nodeIds: ['node-g3'],
              color: '#10b981',
            },
          ],
          crawlDepth: 'shallow',
        },
      );

      expect(response.comparative).toBeDefined();
      expect(response.comparative?.isComparative).toBe(true);
      expect(response.comparative?.groups).toHaveLength(3);
      expect(response.comparative?.groups?.map((g) => g.id)).toEqual([
        'symbolic',
        'connectionist',
        'evolutionary',
      ]);
      const level0Nodes = response.nodes.filter((n) => n.level === 0);
      expect(level0Nodes).toHaveLength(3);
      expect(level0Nodes.map((n) => n.groupOrigin)).toEqual(
        expect.arrayContaining(['symbolic', 'connectionist', 'evolutionary']),
      );
    });

    it('applies cross-group MMR repulsion to steer candidates away from competing group centroids', async () => {
      (mockGraphs.findAccessible as jest.Mock).mockResolvedValueOnce({
        id: 'graph-repulsion',
        userId: 'user-1',
        updatedAt: new Date(),
        nodes: [
          { id: 'node-alpha', data: { title: 'Hypothesis Alpha' } },
          { id: 'node-beta', data: { title: 'Hypothesis Beta' } },
          { id: 'node-cand-near-beta', data: { title: 'Near Beta Topic' } },
          { id: 'node-cand-distinct', data: { title: 'Distinct Alpha Topic' } },
        ],
        edges: [
          { id: 'e1', source: 'node-alpha', target: 'node-cand-near-beta' },
          { id: 'e2', source: 'node-alpha', target: 'node-cand-distinct' },
        ],
      });

      // Alpha seed vector: [1, 0, 0], Beta seed vector: [0, 1, 0]
      (mockWeaviate.hybridSearch as jest.Mock).mockImplementation(
        async (_graphId, _query, nodeIds) => {
          if (nodeIds.includes('node-alpha')) {
            return [
              {
                graphId: 'graph-repulsion',
                sourceId: 's-alpha',
                sourceName: 'alpha.md',
                nodeId: 'node-alpha',
                content: 'Alpha seed content',
                score: 0.9,
                vector: [1.0, 0.0, 0.0],
              },
            ];
          }
          if (nodeIds.includes('node-beta')) {
            return [
              {
                graphId: 'graph-repulsion',
                sourceId: 's-beta',
                sourceName: 'beta.md',
                nodeId: 'node-beta',
                content: 'Beta seed content',
                score: 0.9,
                vector: [0.0, 1.0, 0.0],
              },
            ];
          }
          return [];
        },
      );

      // Hop 1 from Alpha: candidate 1 is very close to Beta ([0.1, 0.95, 0.0]), candidate 2 is distinct ([0.9, 0.1, 0.0])
      (mockWeaviate.vectorSearch as jest.Mock).mockImplementation(
        async (_graphId, _vector, targetNodeIds) => {
          if (
            targetNodeIds.includes('node-cand-near-beta') ||
            targetNodeIds.includes('node-cand-distinct')
          ) {
            return [
              {
                graphId: 'graph-repulsion',
                sourceId: 's-near-beta',
                sourceName: 'near-beta.md',
                nodeId: 'node-cand-near-beta',
                content: 'Candidate closely matching Beta topic',
                score: 0.88,
                vector: [0.1, 0.95, 0.0],
              },
              {
                graphId: 'graph-repulsion',
                sourceId: 's-distinct',
                sourceName: 'distinct.md',
                nodeId: 'node-cand-distinct',
                content: 'Candidate keeping distinct Alpha direction',
                score: 0.86,
                vector: [0.9, 0.1, 0.0],
              },
            ];
          }
          return [];
        },
      );

      (mockRerank.rerank as jest.Mock).mockImplementation((_query, texts) =>
        Promise.resolve(
          texts.map((_: string, idx: number) => ({
            index: idx,
            score: 0.88 - idx * 0.02,
          })),
        ),
      );

      const response = await service.crawl(
        {
          userId: 'user-1',
          tier: 'REGISTERED',
          email: 'user@test.com',
          username: 'testuser',
          isGuest: false,
        },
        {
          graphId: 'graph-repulsion',
          query: 'alpha vs beta',
          startingNodeIds: ['node-alpha'],
          groupBStartingNodeIds: ['node-beta'],
          comparativeMode: true,
          maxCandidatesPerStep: 1,
          crawlDepth: 'shallow',
          enableDigs: false,
          enableLinks: true,
          enableJumps: true,
        },
      );

      expect(response.nodes.length).toBeGreaterThanOrEqual(3);
      expect(response.comparative).toBeDefined();
      expect(response.comparative?.isComparative).toBe(true);
    });
  });

  describe('selectDiverseBranches', () => {
    it('guarantees balanced representation across hypothesis groups in comparative mode', () => {
      // Group A has 6 high-scoring branches, Group B has 4 lower-scoring branches
      const branches = [
        {
          crawlNode: { score: 0.95, nodeId: 'n1', rerankScore: 0.95 },
          groupId: 'groupA',
        },
        {
          crawlNode: { score: 0.94, nodeId: 'n1', rerankScore: 0.94 },
          groupId: 'groupA',
        },
        {
          crawlNode: { score: 0.93, nodeId: 'n2', rerankScore: 0.93 },
          groupId: 'groupA',
        },
        {
          crawlNode: { score: 0.92, nodeId: 'n2', rerankScore: 0.92 },
          groupId: 'groupA',
        },
        {
          crawlNode: { score: 0.91, nodeId: 'n3', rerankScore: 0.91 },
          groupId: 'groupA',
        },
        {
          crawlNode: { score: 0.9, nodeId: 'n3', rerankScore: 0.9 },
          groupId: 'groupA',
        },
        {
          crawlNode: { score: 0.6, nodeId: 'n4', rerankScore: 0.6 },
          groupId: 'groupB',
        },
        {
          crawlNode: { score: 0.58, nodeId: 'n4', rerankScore: 0.58 },
          groupId: 'groupB',
        },
        {
          crawlNode: { score: 0.55, nodeId: 'n5', rerankScore: 0.55 },
          groupId: 'groupB',
        },
        {
          crawlNode: { score: 0.5, nodeId: 'n5', rerankScore: 0.5 },
          groupId: 'groupB',
        },
      ];

      const selected = selectDiverseBranches(branches, 6, true);
      expect(selected).toHaveLength(6);

      const groupACount = selected.filter((b) => b.groupId === 'groupA').length;
      const groupBCount = selected.filter((b) => b.groupId === 'groupB').length;

      // Without diversity beam search, group A would have taken all 6 slots.
      // With diversity beam search, group B is guaranteed slots.
      expect(groupBCount).toBeGreaterThanOrEqual(3);
      expect(groupACount).toBeGreaterThanOrEqual(3);
    });

    it('preserves multi-topic coverage across distinct graph nodes in single crawl mode', () => {
      const branches = [
        { crawlNode: { score: 0.99, nodeId: 'node-A' } },
        { crawlNode: { score: 0.98, nodeId: 'node-A' } },
        { crawlNode: { score: 0.97, nodeId: 'node-A' } },
        { crawlNode: { score: 0.96, nodeId: 'node-A' } },
        { crawlNode: { score: 0.7, nodeId: 'node-B' } },
        { crawlNode: { score: 0.65, nodeId: 'node-C' } },
        { crawlNode: { score: 0.6, nodeId: 'node-D' } },
      ];

      const selected = selectDiverseBranches(branches, 4, false);
      expect(selected).toHaveLength(4);

      const distinctNodes = new Set(selected.map((b) => b.crawlNode.nodeId));
      expect(distinctNodes.has('node-A')).toBe(true);
      expect(distinctNodes.has('node-B')).toBe(true);
      expect(distinctNodes.has('node-C')).toBe(true);
      expect(distinctNodes.has('node-D')).toBe(true);
    });
  });

  describe('SearchService Graph Vocabulary & Contextual Suggestions', () => {
    let testService: SearchService;
    let mockDb: Partial<DatabaseService>;
    let mockRedis: Partial<RedisService>;
    let mockGraphs: Partial<GraphsService>;
    let mockAuth: Partial<AuthService>;
    let mockAuthorization: Partial<AuthorizationService>;

    beforeEach(() => {
      mockDb = {
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('SELECT "nodes" FROM "Graph"')) {
            return Promise.resolve([
              {
                nodes: [
                  {
                    id: 'node-1',
                    data: { title: 'Kubernetes Nodes', category: 'DevOps' },
                  },
                  {
                    id: 'node-2',
                    data: { title: 'Envoy Proxy', category: 'Networking' },
                  },
                ],
              },
            ]);
          }
          if (sql.includes('FROM "NodeSource"')) {
            return Promise.resolve([
              {
                id: 'source-1',
                nodeId: 'node-1',
                name: 'k8s.md',
                content:
                  '# Pod Lifecycle\n**Horizontal Pod Autoscaler** manages replicas.',
              },
              {
                id: 'source-2',
                nodeId: 'node-2',
                name: 'envoy.md',
                content: '## Traffic Routing\nEnvoy routes ingress traffic.',
              },
            ]);
          }
          if (sql.includes('synonymsConfig')) {
            return Promise.resolve([
              {
                value: { k8s: ['kubernetes', 'container orchestration'] },
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      mockRedis = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(1),
        mget: jest.fn().mockResolvedValue([]),
        publish: jest.fn().mockResolvedValue(1),
        createSubscriber: jest.fn().mockReturnValue({
          connect: jest.fn().mockResolvedValue(undefined),
          subscribe: jest.fn().mockResolvedValue(undefined),
          on: jest.fn(),
          quit: jest.fn().mockResolvedValue(undefined),
        } as any),
      };

      mockGraphs = {
        findAccessible: jest.fn().mockResolvedValue({
          id: 'graph-1',
          nodes: [
            {
              id: 'node-1',
              data: { title: 'Kubernetes Nodes', category: 'DevOps' },
            },
            {
              id: 'node-2',
              data: { title: 'Envoy Proxy', category: 'Networking' },
            },
          ],
        }),
      };

      mockAuth = {
        requireIdentity: jest
          .fn()
          .mockReturnValue({ userId: 'user-1', tier: 'PRO' }),
      };

      mockAuthorization = {
        assertCan: jest.fn(),
      };

      testService = new SearchService(
        mockDb as DatabaseService,
        {} as EmbeddingService,
        {} as RerankService,
        {} as WeaviateService,
        mockGraphs as GraphsService,
        mockAuth as AuthService,
        mockAuthorization as AuthorizationService,
        mockRedis as RedisService,
      );
    });

    it('uses in-memory synonyms without querying Redis or database repeatedly', async () => {
      testService.setInMemorySynonyms({ k8s: ['kubernetes'] });
      const syns = await testService.getActiveSynonyms();
      expect(syns).toEqual({ k8s: ['kubernetes'] });
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('harvests vocabulary from Graph nodes and ready sources on cache miss, saving to Redis', async () => {
      const vocab = await testService.getGraphVocabulary('graph-1');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT "nodes" FROM "Graph"'),
        ['graph-1'],
      );
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM "NodeSource"'),
        ['graph-1'],
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        'graph:graph-1:vocabulary',
        expect.any(String),
        86400 * 7,
      );

      const terms = vocab.map((v) => v.term);
      expect(terms).toContain('Kubernetes Nodes');
      expect(terms).toContain('Pod Lifecycle');
      expect(terms).toContain('Horizontal Pod Autoscaler');
      expect(terms).toContain('Envoy Proxy');
    });

    it('returns cached vocabulary from Redis on cache hit', async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce(
        JSON.stringify([
          {
            term: 'Cached Term',
            normalized: 'cached term',
            nodeIds: ['n1'],
            weight: 10,
          },
        ]),
      );

      const vocab = await testService.getGraphVocabulary('graph-1');
      expect(vocab).toEqual([expect.objectContaining({ term: 'Cached Term' })]);
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('uses batch mget for pre-cached source vocabularies when aggregating graph vocabulary', async () => {
      (mockRedis.get as jest.Mock).mockResolvedValue(null);
      (mockRedis.mget as jest.Mock).mockImplementation((keys: string[]) => {
        return Promise.resolve(
          keys.map((key) => {
            if (key === 'source:source-1:vocabulary') {
              return JSON.stringify([
                {
                  term: 'Fast Pre-Cached Concept',
                  normalized: 'fast pre-cached concept',
                  nodeIds: ['node-1'],
                  weight: 8,
                  sourceType: 'bold',
                },
              ]);
            }
            return null;
          }),
        );
      });

      const vocab = await testService.getGraphVocabulary('graph-1');
      expect(mockRedis.mget).toHaveBeenCalledWith([
        'source:source-1:vocabulary',
        'source:source-2:vocabulary',
      ]);
      const terms = vocab.map((v) => v.term);
      expect(terms).toContain('Fast Pre-Cached Concept');
      expect(terms).toContain('Kubernetes Nodes');
    });

    it('filters vocabulary by selected nodeIds and caches with scoped node key', async () => {
      mockDb.query = jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT "nodes" FROM "Graph"')) {
          return Promise.resolve([
            {
              nodes: [
                { id: 'node-1', data: { title: 'Node 1' } },
                { id: 'node-2', data: { title: 'Node 2' } },
              ],
            },
          ]);
        }
        if (sql.includes('FROM "NodeSource"')) {
          return Promise.resolve([
            {
              id: 'source-1',
              nodeId: 'node-1',
              content: '# Kubernetes\nDetails about pods',
              name: 'k8s.md',
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const vocab = await testService.getGraphVocabulary('graph-1', ['node-1']);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('AND "nodeId" = ANY($2)'),
        ['graph-1', ['node-1']],
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        'graph:graph-1:nodes:node-1:vocabulary',
        expect.any(String),
        86400 * 7,
      );
      expect(vocab.some((v) => v.term === 'Node 1')).toBe(true);
      expect(vocab.some((v) => v.term === 'Node 2')).toBe(false);
    });

    it('getVocabulary asserts authorization and delegates to getGraphVocabulary', async () => {
      const vocab = await testService.getVocabulary(
        { userId: 'user-1' } as any,
        'graph-1',
        ['node-1'],
      );

      expect(mockGraphs.findAccessible).toHaveBeenCalledWith(
        expect.anything(),
        'graph-1',
      );
      expect(mockAuthorization.assertCan).toHaveBeenCalledWith(
        expect.anything(),
        'query',
        'Graph',
        expect.anything(),
      );
      expect(Array.isArray(vocab)).toBe(true);
    });

    it('invalidates graph vocabulary cache on demand', async () => {
      await testService.invalidateGraphVocabulary('graph-1');
      expect(mockRedis.del).toHaveBeenCalledWith('graph:graph-1:vocabulary');
    });

    it('returns contextual suggestions tailored to selected nodes and query prefix', async () => {
      const suggestions = await testService.getSuggestions(
        { userId: 'user-1' } as any,
        'graph-1',
        ['node-1', 'node-2'],
        '',
        6,
      );

      expect(mockAuthorization.assertCan).toHaveBeenCalled();
      expect(suggestions.querySuggestions.length).toBeGreaterThan(0);
      expect(
        suggestions.querySuggestions.some((q) =>
          q.includes('Kubernetes Nodes and Envoy Proxy integration'),
        ),
      ).toBe(true);
      expect(
        suggestions.vocabularySuggestions.some(
          (v) => v.term === 'Pod Lifecycle',
        ),
      ).toBe(true);
    });

    it('filters suggestions when a query prefix is provided', async () => {
      const suggestions = await testService.getSuggestions(
        { userId: 'user-1' } as any,
        'graph-1',
        ['node-1'],
        'pod',
        5,
      );

      expect(
        suggestions.querySuggestions.some((q) =>
          q.toLowerCase().includes('pod'),
        ),
      ).toBe(true);
      expect(
        suggestions.vocabularySuggestions.some((v) =>
          v.term.toLowerCase().includes('pod'),
        ),
      ).toBe(true);
    });

    it('initializes pub/sub subscriber, registers error handler, and handles incoming settings update', async () => {
      let messageHandler: ((channel: string, msg: string) => void) | undefined;
      let errorHandler: ((err: Error) => void) | undefined;

      const mockSub = {
        connect: jest.fn().mockResolvedValue(undefined),
        subscribe: jest.fn().mockResolvedValue(undefined),
        on: jest.fn((event: string, cb: any) => {
          if (event === 'message') messageHandler = cb;
          if (event === 'error') errorHandler = cb;
        }),
        quit: jest.fn().mockResolvedValue(undefined),
      };
      (mockRedis.createSubscriber as jest.Mock).mockReturnValue(mockSub);

      await testService.initPubSubSubscriber();

      expect(mockRedis.createSubscriber).toHaveBeenCalled();
      expect(mockSub.connect).toHaveBeenCalled();
      expect(mockSub.subscribe).toHaveBeenCalledWith('system:settings:updated');
      expect(errorHandler).toBeDefined();
      expect(() =>
        errorHandler!(new Error('Subscriber disconnected')),
      ).not.toThrow();

      // Trigger message update
      messageHandler!(
        'system:settings:updated',
        JSON.stringify({ synonymsConfig: { helm: ['k8s package'] } }),
      );
      const syns = await testService.getActiveSynonyms();
      expect(syns).toEqual({ helm: ['k8s package'] });
    });

    it('handles subscriber connect or subscribe failures gracefully without throwing', async () => {
      const failingSub = {
        connect: jest.fn().mockRejectedValue(new Error('Network error')),
        subscribe: jest
          .fn()
          .mockRejectedValue(new Error('Stream not writeable')),
        on: jest.fn(),
        quit: jest.fn().mockResolvedValue(undefined),
      };
      (mockRedis.createSubscriber as jest.Mock).mockReturnValue(failingSub);

      await expect(testService.initPubSubSubscriber()).resolves.not.toThrow();
    });
  });
});
