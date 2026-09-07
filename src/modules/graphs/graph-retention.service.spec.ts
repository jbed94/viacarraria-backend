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

import { ConfigService } from '@nestjs/config';

import { DatabaseService } from '../../common/services/database.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import { StorageService } from '../../common/services/storage.service.js';
import { WeaviateService } from '../../common/services/weaviate.service.js';
import { GraphRetentionService } from './graph-retention.service.js';

describe('GraphRetentionService', () => {
  let service: GraphRetentionService;
  let mockDb: {
    query: jest.Mock;
    one: jest.Mock;
  };
  let mockStorage: {
    deletePrefix: jest.Mock;
    deleteObject: jest.Mock;
    getObject: jest.Mock;
    putObject: jest.Mock;
    archiveGraphData: jest.Mock;
    extractTarGz: jest.Mock;
  };
  let mockWeaviate: {
    deleteTenant: jest.Mock;
    ensureTenant: jest.Mock;
  };
  let mockRedis: {
    del: jest.Mock;
    set: jest.Mock;
  };
  let mockRabbitMq: {
    publishParsingJob: jest.Mock;
  };
  let mockNotifications: {
    hasRecentWarning: jest.Mock;
    createNotification: jest.Mock;
  };

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
      one: jest.fn(),
    };
    mockStorage = {
      deletePrefix: jest.fn().mockResolvedValue(3),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      getObject: jest.fn(),
      putObject: jest.fn().mockResolvedValue({
        key: 'test',
        location: 'test',
        storageDriver: 'local',
      }),
      archiveGraphData: jest.fn().mockResolvedValue({
        key: 'archives/graphs/g-1.tar.gz',
        sizeBytes: 1000,
      }),
      extractTarGz: jest.fn(),
    };
    mockWeaviate = {
      deleteTenant: jest.fn().mockResolvedValue(undefined),
      ensureTenant: jest.fn().mockResolvedValue(undefined),
    };
    mockRedis = {
      del: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
    };
    mockRabbitMq = {
      publishParsingJob: jest.fn().mockResolvedValue(undefined),
    };
    mockNotifications = {
      hasRecentWarning: jest.fn().mockResolvedValue(false),
      createNotification: jest.fn().mockResolvedValue({ id: 'notif-1' }),
    };

    const config = new ConfigService({
      GRAPH_INACTIVITY_RETENTION_DAYS: '90',
      GRAPH_RETENTION_GRACE_PERIOD_DAYS: '7',
      GRAPH_RETENTION_SCHEDULE_INTERVAL_HOURS: '24',
      GRAPH_RETENTION_AUTO_PURGE_ENABLED: 'false', // Disable automatic timer in tests
    });

    service = new GraphRetentionService(
      mockDb as unknown as DatabaseService,
      mockStorage as unknown as StorageService,
      mockWeaviate as unknown as WeaviateService,
      mockRedis as unknown as RedisService,
      config,
      mockNotifications as any,
      mockRabbitMq as any,
    );
  });

  describe('scheduleInactiveGraphs', () => {
    it('identifies graphs inactive for 90+ days, sets scheduledForDeletionAt, and dispatches in-app notification', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          {
            id: 'graph-inactive-1',
            title: 'Forgotten Project',
            userId: 'user-owner-1',
            lastAccessedAt: new Date(Date.now() - 95 * 86400000),
          },
        ]) // SELECT candidates
        .mockResolvedValueOnce([]); // UPDATE scheduledForDeletionAt

      const result = await service.scheduleInactiveGraphs(90, 7);

      expect(result.count).toBe(1);
      expect(result.graphIds).toEqual(['graph-inactive-1']);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('"lastAccessedAt" < CURRENT_TIMESTAMP'),
        ['90'],
      );
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('SET "scheduledForDeletionAt"'),
        ['7', ['graph-inactive-1']],
      );
      expect(mockNotifications.createNotification).toHaveBeenCalledWith(
        'user-owner-1',
        expect.objectContaining({
          type: 'GRAPH_INACTIVITY_WARNING',
          data: expect.objectContaining({ graphId: 'graph-inactive-1' }),
        }),
      );
    });

    it('returns zero when no inactive graphs exist', async () => {
      mockDb.query.mockResolvedValueOnce([]);
      const result = await service.scheduleInactiveGraphs(90, 7);

      expect(result.count).toBe(0);
      expect(result.graphIds).toHaveLength(0);
    });
  });

  describe('purgeScheduledGraphs', () => {
    it('cascading purges expired graphs from storage, weaviate, redis, and database', async () => {
      mockDb.query
        .mockResolvedValueOnce([
          { id: 'graph-expired-1', title: 'Ancient Graph' },
        ]) // SELECT expired
        .mockResolvedValueOnce([
          {
            id: 'src-1',
            fileUrl: 's3://bucket/sources/graph-expired-1/doc1.pdf',
          },
          {
            id: 'src-2',
            fileUrl: 's3://bucket/sources/graph-expired-1/doc2.pdf',
          },
        ]) // SELECT NodeSources
        .mockResolvedValueOnce([]); // DELETE FROM "Graph"

      const result = await service.purgeScheduledGraphs();

      expect(result.count).toBe(1);
      expect(result.details[0]!.graphId).toBe('graph-expired-1');
      expect(result.details[0]!.sourcesPurged).toBe(2);

      // Verify S3 storage prefix and objects deleted
      expect(mockStorage.deletePrefix).toHaveBeenCalledWith(
        'sources/graph-expired-1',
      );
      expect(mockStorage.deleteObject).toHaveBeenCalledWith(
        's3://bucket/sources/graph-expired-1/doc1.pdf',
      );
      expect(mockStorage.deleteObject).toHaveBeenCalledWith(
        's3://bucket/sources/graph-expired-1/doc2.pdf',
      );

      // Verify Weaviate tenant deleted
      expect(mockWeaviate.deleteTenant).toHaveBeenCalledWith('graph-expired-1');

      // Verify Redis keys deleted
      expect(mockRedis.del).toHaveBeenCalledWith('graph:graph-expired-1:*');

      // Verify Postgres deletion
      expect(mockDb.query).toHaveBeenCalledWith(
        'DELETE FROM "Graph" WHERE "id" = $1',
        ['graph-expired-1'],
      );
    });

    it('does nothing when no graphs have reached scheduled deletion time', async () => {
      mockDb.query.mockResolvedValueOnce([]);
      const result = await service.purgeScheduledGraphs();
      expect(result.count).toBe(0);
      expect(mockStorage.deletePrefix).not.toHaveBeenCalled();
      expect(mockWeaviate.deleteTenant).not.toHaveBeenCalled();
    });
  });

  describe('cancelScheduledDeletion', () => {
    it('clears scheduledForDeletionAt and touches lastAccessedAt', async () => {
      mockDb.query.mockResolvedValueOnce([{ id: 'graph-reactivated' }]);

      const success =
        await service.cancelScheduledDeletion('graph-reactivated');
      expect(success).toBe(true);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('"scheduledForDeletionAt" = NULL'),
        ['graph-reactivated'],
      );
    });
  });

  describe('runRetentionSweep', () => {
    it('executes both schedule and purge sweeps', async () => {
      mockDb.query
        .mockResolvedValueOnce([]) // schedule candidates
        .mockResolvedValueOnce([]); // purge candidates

      const sweep = await service.runRetentionSweep();
      expect(sweep.scheduled.count).toBe(0);
      expect(sweep.purged.count).toBe(0);
    });
  });

  describe('restoreGraphFromArchive', () => {
    it('throws NotFoundException when archive record does not exist', async () => {
      mockDb.one.mockResolvedValueOnce(null);
      await expect(
        service.restoreGraphFromArchive('missing-archive', 'user-1'),
      ).rejects.toThrow('No cold-storage archive found');
    });

    it('throws ForbiddenException when user is not owner and not admin', async () => {
      mockDb.one.mockResolvedValueOnce({
        id: 'arch-1',
        graphId: 'g-1',
        userId: 'user-owner',
        title: 'Owned Graph',
        archiveUrl: 'archives/graphs/g-1.tar.gz',
      });
      await expect(
        service.restoreGraphFromArchive('arch-1', 'user-stranger', false),
      ).rejects.toThrow(
        'You do not have permission to restore this graph archive',
      );
    });

    it('throws BadRequestException when manifest.json is missing in archive', async () => {
      mockDb.one.mockResolvedValueOnce({
        id: 'arch-1',
        graphId: 'g-1',
        userId: 'user-1',
        title: 'Corrupt Archive',
        archiveUrl: 'archives/graphs/g-1.tar.gz',
      });
      mockStorage.getObject.mockResolvedValueOnce({
        buffer: Buffer.from('archive binary'),
      });
      mockStorage.extractTarGz.mockReturnValueOnce([
        { name: 'sources/doc.txt', buffer: Buffer.from('text') },
      ]);

      await expect(
        service.restoreGraphFromArchive('arch-1', 'user-1', false),
      ).rejects.toThrow('Invalid archive: manifest.json is missing');
    });

    it('successfully restores graph and sources, removes archive and notifies user', async () => {
      mockDb.one
        .mockResolvedValueOnce({
          id: 'arch-1',
          graphId: 'g-1',
          userId: 'user-1',
          title: 'Restored Graph',
          archiveUrl: 'archives/graphs/g-1.tar.gz',
        })
        .mockResolvedValueOnce(null);

      const manifestData = {
        graph: {
          id: 'g-1',
          title: 'Restored Graph',
          description: 'A restored graph description',
          userId: 'user-1',
          nodes: [{ id: 'n-1' }],
          edges: [],
        },
        sources: [
          {
            id: 's-1',
            nodeId: 'n-1',
            name: 'document.pdf',
            fileType: 'application/pdf',
            fileUrl: 'sources/g-1/doc.pdf',
            fileHash: 'hash-123',
            sizeBytes: 1024,
            content: 'Extracted PDF text',
          },
        ],
      };

      mockStorage.getObject.mockResolvedValueOnce({
        buffer: Buffer.from('mock tar.gz binary'),
      });
      mockStorage.extractTarGz.mockReturnValueOnce([
        {
          name: 'manifest.json',
          buffer: Buffer.from(JSON.stringify(manifestData)),
        },
        { name: 'sources/s-1_document.pdf', buffer: Buffer.from('pdf bytes') },
      ]);

      mockDb.query.mockResolvedValue([]);

      const result = await service.restoreGraphFromArchive(
        'arch-1',
        'user-1',
        false,
      );

      expect(result).toEqual({
        id: 'g-1',
        title: 'Restored Graph',
        userId: 'user-1',
        sourceCount: 1,
        restored: true,
      });

      expect(mockStorage.putObject).toHaveBeenCalledWith(
        'sources/g-1/doc.pdf',
        Buffer.from('pdf bytes'),
        'application/pdf',
      );

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "Graph"'),
        expect.any(Array),
      );

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "NodeSource"'),
        expect.any(Array),
      );

      expect(mockDb.query).toHaveBeenCalledWith(
        'DELETE FROM "GraphArchive" WHERE "id" = $1',
        ['arch-1'],
      );

      expect(mockNotifications.createNotification).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          type: 'GRAPH_RESTORED',
          data: { graphId: 'g-1' },
        }),
      );

      expect(mockWeaviate.ensureTenant).toHaveBeenCalledWith('g-1');
      expect(mockRabbitMq.publishParsingJob).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 's-1',
          graphId: 'g-1',
          fileName: 'document.pdf',
        }),
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^JOB_.*:PROGRESS$/),
        '0',
        3600,
      );
    });
  });

  describe('getAuditStats', () => {
    it('returns complete audit metrics and queries sizeBytes on NodeSource', async () => {
      mockDb.query
        .mockResolvedValueOnce([{ count: '5' }]) // inactive
        .mockResolvedValueOnce([{ count: '2' }]) // scheduled
        .mockResolvedValueOnce([{ count: '3' }]) // exempt
        .mockResolvedValueOnce([{ count: '4' }]) // archives
        .mockResolvedValueOnce([{ count: '10' }]) // total
        .mockResolvedValueOnce([{ totalBytes: '204800' }]); // sizeBytes sum

      const stats = await service.getAuditStats();

      expect(stats.inactiveCandidateCount).toBe(5);
      expect(stats.scheduledForDeletionCount).toBe(2);
      expect(stats.exemptGraphsCount).toBe(3);
      expect(stats.activeArchivesCount).toBe(4);
      expect(stats.totalActiveGraphs).toBe(10);
      expect(stats.estimatedReclaimBytes).toBe(204800);

      // Verify the query referenced sizeBytes on NodeSource
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('SUM(s."sizeBytes")'),
      );
    });
  });
});
