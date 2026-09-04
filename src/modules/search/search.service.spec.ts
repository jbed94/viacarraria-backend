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
  applyTabularBoosting,
  chunkText,
  determineAnswerType,
  groupChunks,
  isTableChunk,
  isTabularQuery,
  lexicalScore,
} from './search.utils.js';
import type { SearchChunk } from '../../common/types.js';
import { SearchService } from './search.service.js';
import type { DatabaseService } from '../../common/services/database.service.js';
import type { EmbeddingService } from '../../common/services/embedding.service.js';
import type { RerankService } from '../../common/services/rerank.service.js';
import type { WeaviateService } from '../../common/services/weaviate.service.js';
import type { GraphsService } from '../graphs/graphs.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { AuthorizationService } from '../../common/authorization/ability.js';

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

describe('SearchService - Extended Context Search', () => {
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
      vectorSearch: jest.fn(),
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

  it('includes other chunks from the same source in extended context search', async () => {
    const directHit = {
      chunk: {
        graphId: 'graph-1',
        sourceId: 'source-same',
        sourceName: 'Course-Handbook.pdf',
        nodeId: 'node-1',
        content: 'Grading breakdown for final exam is 40%.',
        context: 'Grading breakdown context',
        startChar: 100,
        endChar: 150,
        pageNum: 3,
        score: 0.9,
      },
      vector: [0.1, 0.2, 0.3],
    };

    // Weaviate returns another chunk from the same source
    (mockWeaviate.vectorSearch as jest.Mock).mockResolvedValue([
      {
        graphId: 'graph-1',
        sourceId: 'source-same',
        sourceName: 'Course-Handbook.pdf',
        nodeId: 'node-1',
        content: 'Grading breakdown for midterm is 30%.',
        context: 'Grading breakdown context',
        startChar: 200,
        endChar: 245,
        pageNum: 3,
        score: 0.85,
      },
    ]);

    const result = await service.extendMatches(
      'graph-1',
      [], // no adjacent edges
      [directHit],
      true,
      3,
      'grading breakdown',
    );

    expect(result).toHaveLength(1);
    const firstHit = result[0];
    expect(firstHit?.extendedContext).toBeDefined();
    expect(firstHit?.extendedContext).toHaveLength(1);
    expect(firstHit?.extendedContext?.[0]?.sourceId).toBe('source-same');
    expect(firstHit?.extendedContext?.[0]?.startChar).toBe(200);
    expect(firstHit?.extendedContext?.[0]?.kind).toBe('EXTENDED');
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
        tier: 'PRO',
        email: 'user@test.com',
        username: 'testuser',
        isGuest: false,
      }),
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
        tier: 'PRO',
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
        tier: 'PRO',
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
          tier: 'PRO',
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
});
