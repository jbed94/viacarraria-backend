jest.mock('better-auth', () => ({ betterAuth: jest.fn() }));
jest.mock('better-auth/plugins', () => ({ anonymous: jest.fn() }));
jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn() }));
jest.mock('../../auth.js', () => ({
  auth: {
    api: {
      getSession: jest.fn(),
    },
  },
  authDatabase: {
    query: jest.fn(),
    end: jest.fn(),
  },
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdContextService, slugifyTag } from './ad-context.service.js';
import type { DatabaseService } from '../../common/services/database.service.js';
import type { RerankService } from '../../common/services/rerank.service.js';
import type { RedisService } from '../../common/services/redis.service.js';

describe('AdContextService', () => {
  let service: AdContextService;
  let mockDatabase: jest.Mocked<Partial<DatabaseService>>;
  let mockRerank: jest.Mocked<Partial<RerankService>>;
  let mockRedis: jest.Mocked<Partial<RedisService>>;

  const sampleTags = [
    {
      id: 'tag-1',
      name: 'Artificial Intelligence',
      slug: 'artificial-intelligence',
      description:
        'Machine learning, neural networks, and deep learning algorithms.',
      enabled: true,
      sendCount: 15,
      matchCount: 8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'tag-2',
      name: 'Computer Science',
      slug: 'computer-science',
      description: 'Data structures, algorithms, and software engineering.',
      enabled: true,
      sendCount: 20,
      matchCount: 12,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'tag-3',
      name: 'Biotechnology',
      slug: 'biotechnology',
      description: 'Genomics, bioinformatics, and computational biology.',
      enabled: false,
      sendCount: 2,
      matchCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    mockDatabase = {
      query: jest.fn().mockResolvedValue([...sampleTags]),
      one: jest.fn().mockImplementation((text: string, values?: any[]) => {
        if (text.includes('WHERE "id" = $1')) {
          const found = sampleTags.find((t) => t.id === values?.[0]);
          return Promise.resolve(found);
        }
        if (text.includes('WHERE "slug" = $1')) {
          const found = sampleTags.find((t) => t.slug === values?.[0]);
          return Promise.resolve(found);
        }
        return Promise.resolve(undefined);
      }),
    };

    mockRerank = {
      isConfigured: jest.fn().mockReturnValue(true),
      rerank: jest.fn().mockResolvedValue([
        { index: 0, score: 0.85 },
        { index: 1, score: 0.42 },
      ]),
    };

    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    service = new AdContextService(
      mockDatabase as DatabaseService,
      mockRerank as RerankService,
      mockRedis as RedisService,
    );
  });

  describe('slugifyTag', () => {
    it('generates clean URL-safe slugs', () => {
      expect(slugifyTag('Artificial Intelligence & Machine Learning')).toBe(
        'artificial-intelligence-machine-learning',
      );
      expect(slugifyTag('  Data Science / Analytics  ')).toBe(
        'data-science-analytics',
      );
    });
  });

  describe('getAllTags', () => {
    it('returns all tags when includeDisabled is true', async () => {
      const tags = await service.getAllTags(true);
      expect(tags).toHaveLength(3);
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'SELECT * FROM "AdContextTag" ORDER BY "name" ASC',
        ),
      );
    });

    it('filters enabled tags when includeDisabled is false', async () => {
      await service.getAllTags(false);
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE "enabled" = true'),
      );
    });
  });

  describe('getTagById', () => {
    it('returns tag record when found', async () => {
      const tag = await service.getTagById('tag-1');
      expect(tag.name).toBe('Artificial Intelligence');
    });

    it('throws NotFoundException when tag does not exist', async () => {
      await expect(service.getTagById('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('createTag', () => {
    it('creates tag successfully and returns created record', async () => {
      (mockDatabase.one as jest.Mock)
        .mockResolvedValueOnce(undefined) // existing slug check
        .mockResolvedValueOnce({
          id: 'tag-new',
          name: 'Quantum Computing',
          slug: 'quantum-computing',
          description: 'Qubits and quantum gates.',
          enabled: true,
          sendCount: 0,
          matchCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      const tag = await service.createTag({
        name: 'Quantum Computing',
        description: 'Qubits and quantum gates.',
      });

      expect(tag.name).toBe('Quantum Computing');
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "AdContextTag"'),
        expect.arrayContaining(['Quantum Computing', 'quantum-computing']),
      );
      expect(mockRedis.del).toHaveBeenCalledWith('ad-tags:active');
    });

    it('throws BadRequestException on empty name', async () => {
      await expect(
        service.createTag({ name: '   ', description: 'desc' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException on duplicate slug', async () => {
      (mockDatabase.one as jest.Mock).mockResolvedValueOnce({ id: 'tag-1' });

      await expect(
        service.createTag({
          name: 'Artificial Intelligence',
          description: 'desc',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateTag', () => {
    it('updates tag properties successfully', async () => {
      (mockDatabase.one as jest.Mock)
        .mockResolvedValueOnce(sampleTags[0]) // getTagById check
        .mockResolvedValueOnce(undefined) // slug conflict check
        .mockResolvedValueOnce({
          ...sampleTags[0],
          name: 'AI & Advanced ML',
        }); // getTagById after update

      const updated = await service.updateTag('tag-1', {
        name: 'AI & Advanced ML',
      });

      expect(updated.name).toBe('AI & Advanced ML');
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE "AdContextTag"'),
        expect.any(Array),
      );
    });
  });

  describe('deleteTag', () => {
    it('deletes tag and invalidates cache', async () => {
      const res = await service.deleteTag('tag-1');
      expect(res).toEqual({ success: true });
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM "AdContextTag" WHERE "id" = $1'),
        ['tag-1'],
      );
      expect(mockRedis.del).toHaveBeenCalledWith('ad-tags:active');
    });
  });

  describe('getTagStats', () => {
    it('aggregates total counts and top tags', async () => {
      const stats = await service.getTagStats();
      expect(stats.totalTags).toBe(3);
      expect(stats.enabledTags).toBe(2);
      expect(stats.totalMatches).toBe(21);
      expect(stats.totalSends).toBe(37);
      expect(stats.topMatchedTags[0]?.slug).toBe('computer-science');
    });
  });

  describe('matchSourceWithTags', () => {
    it('uses TEI reranker to score candidate tags and persists matches', async () => {
      (mockDatabase.query as jest.Mock).mockResolvedValue([
        sampleTags[0],
        sampleTags[1],
      ]);

      const matchedSlugs = await service.matchSourceWithTags(
        'source-1',
        'graph-1',
        'Neural Networks Research Note',
        'Convolutional layers and gradient descent optimization.',
        [{ term: 'Neural Networks', weight: 6 }],
      );

      expect(matchedSlugs).toEqual([
        'artificial-intelligence',
        'computer-science',
      ]);
      expect(mockRerank.rerank).toHaveBeenCalled();
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "SourceAdTag"'),
        expect.any(Array),
      );
      expect(mockRedis.del).toHaveBeenCalledWith('graph:graph-1:ad-context');
    });

    it('falls back to token overlap when TEI reranker is unconfigured', async () => {
      (mockRerank.isConfigured as jest.Mock).mockReturnValue(false);
      (mockDatabase.query as jest.Mock).mockResolvedValue([
        sampleTags[0],
        sampleTags[1],
      ]);

      const matchedSlugs = await service.matchSourceWithTags(
        'source-1',
        'graph-1',
        'Deep Learning and Machine Learning Overview',
        'Neural networks architectures.',
        [{ term: 'Machine Learning', weight: 5 }],
      );

      expect(matchedSlugs).toContain('artificial-intelligence');
    });
  });

  describe('getGraphContextualTags', () => {
    it('returns cached results if present in Redis', async () => {
      const cached = {
        graphId: 'graph-1',
        tags: ['artificial-intelligence'],
        details: [
          {
            id: 'tag-1',
            name: 'Artificial Intelligence',
            slug: 'artificial-intelligence',
            score: 2.5,
          },
        ],
      };
      (mockRedis.get as jest.Mock).mockResolvedValueOnce(
        JSON.stringify(cached),
      );

      const result = await service.getGraphContextualTags('graph-1');
      expect(result).toEqual(cached);
      expect(mockDatabase.query).not.toHaveBeenCalled();
    });

    it('queries database and caches results when cache misses', async () => {
      (mockDatabase.query as jest.Mock).mockResolvedValueOnce([
        {
          id: 'tag-1',
          name: 'Artificial Intelligence',
          slug: 'artificial-intelligence',
          totalScore: '3.5',
          frequency: '2',
        },
      ]);

      const result = await service.getGraphContextualTags('graph-1');
      expect(result.tags).toEqual(['artificial-intelligence']);
      expect(result.details[0]?.score).toBe(3.5);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'graph:graph-1:ad-context',
        expect.any(String),
        600,
      );
    });
  });

  describe('recordTagImpression', () => {
    it('increments sendCount in database for matched slugs', async () => {
      await service.recordTagImpression([
        'artificial-intelligence',
        'biotechnology',
      ]);
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringMatching(
          /UPDATE\s+"AdContextTag"[\s\S]+"sendCount"\s*=\s*"sendCount"\s*\+\s*1/,
        ),
        [['artificial-intelligence', 'biotechnology']],
      );
    });

    it('safely ignores empty slug arrays', async () => {
      await service.recordTagImpression([]);
      expect(mockDatabase.query).not.toHaveBeenCalled();
    });
  });

  describe('invalidateGraphContext', () => {
    it('deletes graph context key from Redis', async () => {
      await service.invalidateGraphContext('graph-123');
      expect(mockRedis.del).toHaveBeenCalledWith('graph:graph-123:ad-context');
    });
  });

  describe('recalculateMatchCounts', () => {
    it('executes match count update query', async () => {
      await service.recalculateMatchCounts();
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE\s+"AdContextTag"[\s\S]+"matchCount"\s*=/),
      );
    });
  });

  describe('setSourceAdTags', () => {
    it('persists matches, recalculates match counts, and invalidates graph cache', async () => {
      await service.setSourceAdTags('source-1', 'graph-1', [
        { tagId: 'tag-1', score: 0.95 },
      ]);
      expect(mockDatabase.query).toHaveBeenCalledWith(
        'DELETE FROM "SourceAdTag" WHERE "sourceId" = $1',
        ['source-1'],
      );
      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO "SourceAdTag"/),
        expect.arrayContaining(['source-1', 'tag-1', 0.95]),
      );
      expect(mockRedis.del).toHaveBeenCalledWith('graph:graph-1:ad-context');
    });
  });

  describe('getActiveTags', () => {
    it('returns active tags', async () => {
      (mockDatabase.query as jest.Mock).mockResolvedValueOnce([sampleTags[0]]);
      const tags = await service.getActiveTags();
      expect(tags).toHaveLength(1);
      expect(mockDatabase.query).toHaveBeenCalledWith(
        'SELECT * FROM "AdContextTag" WHERE "enabled" = TRUE ORDER BY "name" ASC',
      );
    });
  });
});
