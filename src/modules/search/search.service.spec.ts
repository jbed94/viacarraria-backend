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
  groupChunks,
  isTableChunk,
  isTabularQuery,
  lexicalScore,
} from './search.utils.js';
import type { SearchChunk } from '../../common/types.js';
import { SearchService } from './search.service.js';
import type { DatabaseService } from '../../common/services/database.service.js';
import type { EmbeddingService } from '../../common/services/embedding.service.js';
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
  let mockWeaviate: Partial<WeaviateService>;
  let mockGraphs: Partial<GraphsService>;

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
    };
    mockEmbeddings = {
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
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
  let mockWeaviate: Partial<WeaviateService>;
  let mockGraphs: Partial<GraphsService>;

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
    };
    mockEmbeddings = {
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
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
