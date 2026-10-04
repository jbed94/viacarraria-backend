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

import { NotFoundException, StreamableFile } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';

import { AdminGuard } from '../../common/guards/admin.guard.js';
import { StorageService } from '../../common/services/storage.service.js';
import { GraphRetentionService } from '../graphs/graph-retention.service.js';
import { AdContextService } from '../plans/ad-context.service.js';
import { PlansService } from '../plans/plans.service.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

describe('AdminController', () => {
  let controller: AdminController;
  let adminService: {
    health: jest.Mock;
    getSystemStatus: jest.Mock;
    getOverviewStats: jest.Mock;
    getUsers: jest.Mock;
    getUserDetails: jest.Mock;
    updateUser: jest.Mock;
    deleteUser: jest.Mock;
    getGraphs: jest.Mock;
    getGraphDetails: jest.Mock;
    updateGraph: jest.Mock;
    updateGraphContent: jest.Mock;
    deleteGraph: jest.Mock;
    deleteArchive: jest.Mock;
    exportUsers: jest.Mock;
    batchUsers: jest.Mock;
    batchGraphs: jest.Mock;
    updateUserStorageLimit: jest.Mock;
    getSystemSettings: jest.Mock;
    updateSystemSettings: jest.Mock;
    getAuditLogs: jest.Mock;
    archiveAuditLogs: jest.Mock;
    getAuditArchives: jest.Mock;
    downloadAuditArchive: jest.Mock;
    getAuditArchiveContent: jest.Mock;
    recordAuditEvent?: jest.Mock;
  };
  let retentionService: {
    runRetentionSweep: jest.Mock;
    getAuditStats: jest.Mock;
    getArchives: jest.Mock;
    getArchiveByGraphId: jest.Mock;
    restoreGraphFromArchive: jest.Mock;
  };
  let storageService: {
    getObject: jest.Mock;
    getStorageProxyStatus: jest.Mock;
  };
  let plansService: {
    getPlanDefinitions: jest.Mock;
    getPlanDefinition: jest.Mock;
    updatePlanDefinition: jest.Mock;
    getAdAnalytics: jest.Mock;
    exportAdTelemetryCsv: jest.Mock;
    rollupAdTelemetryDaily: jest.Mock;
    purgeOldAdTelemetryEvents: jest.Mock;
    getAdTelemetryStatus: jest.Mock;
  };
  let adContextService: {
    getAllTags: jest.Mock;
    getTagStats: jest.Mock;
    createTag: jest.Mock;
    updateTag: jest.Mock;
    deleteTag: jest.Mock;
  };

  beforeEach(async () => {
    adminService = {
      health: jest.fn().mockResolvedValue({
        status: 'ok',
        services: {
          database: true,
          redis: true,
          rabbitMq: true,
          weaviate: true,
        },
      }),
      getSystemStatus: jest.fn().mockResolvedValue({
        health: { status: 'ok', services: { database: true } },
        storageProxy: { isProxy: true },
        process: { uptimeSeconds: 120, nodeVersion: 'v22.0.0' },
      }),
      getOverviewStats: jest.fn().mockResolvedValue({
        users: {
          total: 100,
          registered: 90,
          anonymous: 10,
          newLast30Days: 15,
        },
        similarityQueue: {
          occupation: 'low',
          anonymousThroughputPerMinute: 30,
          registeredThroughputPerMinute: 120,
        },
        storageQuota: {
          defaultStorageLimitMb: 100,
          totalStorageBytes: 104857600,
          totalSources: 80,
        },
        requests: {
          totalQueries: 500,
          queriesLast24Hours: 120,
          avgRequestsPerHour: 5,
          currentRequestsPerHour: 8,
          hourlyDistribution: [],
        },
        graphs: {
          total: 40,
          public: 10,
          private: 30,
          active: 35,
          inactive: 5,
          scheduledForDeletion: 1,
          retentionExempt: 4,
        },
        storage: {
          totalSources: 80,
          totalStorageBytes: 104857600,
          archivesCount: 2,
          archivesBytes: 2048,
        },
      }),
      getUsers: jest.fn().mockResolvedValue({
        users: [
          { id: 'u-1', email: 'user@test.com', subscriptionTier: 'REGISTERED' },
        ],
        pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
      }),
      getUserDetails: jest.fn().mockResolvedValue({
        user: { id: 'u-1', email: 'user@test.com' },
        graphs: [],
        recentQueries: [],
        billingEvents: [],
        storage: { sourcesCount: 0, totalBytes: 0 },
      }),
      updateUser: jest.fn().mockResolvedValue({
        user: { id: 'u-1', subscriptionTier: 'REGISTERED' },
      }),
      deleteUser: jest.fn().mockResolvedValue({ deleted: true, userId: 'u-1' }),
      getGraphs: jest.fn().mockResolvedValue({
        graphs: [{ id: 'g-1', title: 'Admin Graph', isPublic: true }],
        pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
      }),
      getGraphDetails: jest.fn().mockResolvedValue({
        id: 'g-1',
        title: 'Admin Graph',
        nodes: [],
        edges: [],
        sources: [],
      }),
      updateGraph: jest.fn().mockResolvedValue({
        id: 'g-1',
        title: 'Updated Title',
      }),
      updateGraphContent: jest.fn().mockResolvedValue({
        id: 'g-1',
        nodes: [{ id: 'n1' }],
        edges: [],
      }),
      deleteGraph: jest
        .fn()
        .mockResolvedValue({ deleted: true, graphId: 'g-1' }),
      deleteArchive: jest
        .fn()
        .mockResolvedValue({ deleted: true, graphId: 'g-1' }),
      updateUserStorageLimit: jest.fn().mockResolvedValue({
        id: 'u-1',
        storageLimitMb: 250,
      }),
      exportUsers: jest.fn().mockResolvedValue('User ID,Name\nu-1,Test User'),
      batchUsers: jest.fn().mockResolvedValue({
        success: true,
        action: 'set_tier',
        count: 2,
      }),
      batchGraphs: jest.fn().mockResolvedValue({
        success: true,
        action: 'set_retention_exempt',
        count: 2,
      }),
      getSystemSettings: jest.fn().mockResolvedValue({
        retentionDays: 90,
        retentionGraceDays: 7,
        freeTierLimits: {
          maxNodes: 100,
          maxSourcesPerGraph: 5,
          maxSourceSizeBytes: 26214400,
        },
        proTierLimits: {
          maxNodes: 5000,
          maxSourcesPerGraph: 50,
          maxSourceSizeBytes: 104857600,
        },
        rateLimits: {
          anonymousPerMinute: 30,
          authenticatedPerMinute: 120,
          burstMultiplier: 2,
        },
        adConfig: {
          effectiveEcpm: 1.5,
          canvasAdDensity: 35,
          maxCanvasAds: 5,
        },
        maintenanceMode: false,
        updatedAt: '2026-09-01T00:00:00.000Z',
      }),
      updateSystemSettings: jest.fn().mockImplementation(async (patch) => ({
        retentionDays: patch.retentionDays ?? 90,
        retentionGraceDays: patch.retentionGraceDays ?? 7,
        freeTierLimits: {
          maxNodes: patch.freeTierLimits?.maxNodes ?? 100,
          maxSourcesPerGraph: patch.freeTierLimits?.maxSourcesPerGraph ?? 5,
          maxSourceSizeBytes:
            patch.freeTierLimits?.maxSourceSizeBytes ?? 26214400,
        },
        proTierLimits: {
          maxNodes: patch.proTierLimits?.maxNodes ?? 5000,
          maxSourcesPerGraph: patch.proTierLimits?.maxSourcesPerGraph ?? 50,
          maxSourceSizeBytes:
            patch.proTierLimits?.maxSourceSizeBytes ?? 104857600,
        },
        rateLimits: {
          anonymousPerMinute: patch.rateLimits?.anonymousPerMinute ?? 30,
          authenticatedPerMinute:
            patch.rateLimits?.authenticatedPerMinute ?? 120,
          burstMultiplier: patch.rateLimits?.burstMultiplier ?? 2,
        },
        adConfig: {
          effectiveEcpm: patch.adConfig?.effectiveEcpm ?? 1.5,
          canvasAdDensity: patch.adConfig?.canvasAdDensity ?? 35,
          maxCanvasAds: patch.adConfig?.maxCanvasAds ?? 5,
        },
        maintenanceMode: patch.maintenanceMode ?? false,
        updatedAt: '2026-09-06T22:00:00.000Z',
      })),
      getAuditLogs: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'audit-1',
            action: 'system.maintenance_enable',
            targetType: 'system',
            targetId: 'settings',
            actorId: 'admin-1',
            timestamp: '2026-09-07T00:00:00.000Z',
            details: { maintenanceMode: true },
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      archiveAuditLogs: jest.fn().mockResolvedValue({
        id: 'arch-1',
        key: 'audit-logs/2026/09/audit-log-1.json.gz',
        filename: 'audit-log-1.json.gz',
        eventCount: 5,
        sizeBytes: 1024,
        createdAt: '2026-09-07T00:00:00.000Z',
      }),
      getAuditArchives: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'arch-1',
            key: 'audit-logs/2026/09/audit-log-1.json.gz',
            filename: 'audit-log-1.json.gz',
            eventCount: 5,
            sizeBytes: 1024,
            createdAt: '2026-09-07T00:00:00.000Z',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      downloadAuditArchive: jest.fn().mockResolvedValue({
        buffer: Buffer.from('mock-gzip'),
        filename: 'audit-log-1.json.gz',
        contentType: 'application/gzip',
        contentLength: 9,
      }),
      getAuditArchiveContent: jest.fn().mockResolvedValue({
        archive: {
          id: 'arch-1',
          key: 'audit-logs/2026/09/audit-log-1.json.gz',
          filename: 'audit-log-1.json.gz',
          eventCount: 1,
          sizeBytes: 120,
          createdAt: '2026-09-01T00:00:00.000Z',
        },
        items: [
          {
            id: 'ev-1',
            timestamp: '2026-09-01T00:00:00.000Z',
            actorId: 'admin-1',
            action: 'user.role_change',
            targetType: 'user',
            targetId: 'u-1',
            details: {},
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    };

    retentionService = {
      runRetentionSweep: jest.fn().mockResolvedValue({
        scheduled: 2,
        purged: 1,
        archived: 1,
        dryRun: false,
      }),
      getAuditStats: jest.fn().mockResolvedValue({
        inactiveCandidateCount: 2,
        scheduledForDeletionCount: 2,
        exemptGraphsCount: 1,
        activeArchivesCount: 3,
        totalActiveGraphs: 10,
        estimatedReclaimBytes: 1048576,
      }),
      getArchives: jest.fn().mockResolvedValue([
        {
          id: 'arch-1',
          graphId: 'graph-1',
          title: 'Test Graph',
          archiveUrl: 'archives/graphs/graph-1.tar.gz',
          sizeBytes: 1024,
          sourceCount: 2,
        },
      ]),
      getArchiveByGraphId: jest.fn(),
      restoreGraphFromArchive: jest.fn(),
    };

    storageService = {
      getObject: jest.fn(),
      getStorageProxyStatus: jest.fn().mockResolvedValue({
        driver: 's3',
        proxyEndpoint: 'http://minio:9000',
        bucket: 'viacarraria-sources',
        isProxy: true,
        upstreamProvider: 's3',
        upstreamBucket: 'production-s3-backup',
        connected: true,
      }),
    };

    plansService = {
      getPlanDefinitions: jest.fn().mockResolvedValue([
        { tier: 'ANONYMOUS', version: 1 },
        { tier: 'REGISTERED', version: 1 },
      ]),
      getPlanDefinition: jest
        .fn()
        .mockResolvedValue({ tier: 'REGISTERED', version: 1 }),
      updatePlanDefinition: jest.fn().mockResolvedValue({
        tier: 'REGISTERED',
        version: 2,
        name: 'Registered Updated',
      }),
      getAdAnalytics: jest.fn().mockResolvedValue({
        totalImpressions: 120,
        totalCulled: 40,
        totalRefreshes: 10,
        averageViewabilitySeconds: 15.5,
        totalActiveViewableSeconds: 1860,
        estimatedRevenueUsd: 0.18,
        effectiveEcpm: 1.5,
        gpuSavingsPercentage: 25.0,
        consentBreakdown: { personalized: 90, contextual: 20, declined: 10 },
      }),
      exportAdTelemetryCsv: jest
        .fn()
        .mockResolvedValue('id,eventType\n1,impression'),
      rollupAdTelemetryDaily: jest
        .fn()
        .mockResolvedValue({ success: true, rowsRolledUp: 42 }),
      purgeOldAdTelemetryEvents: jest.fn().mockResolvedValue({
        success: true,
        purgedCount: 15,
        retentionDays: 90,
      }),
      getAdTelemetryStatus: jest.fn().mockResolvedValue({
        totalEventsCount: 100,
        totalRollupsCount: 10,
        oldestEventDate: '2026-06-01T00:00:00.000Z',
        newestEventDate: '2026-09-16T12:00:00.000Z',
        lastRollupDate: '2026-09-15',
        retentionDays: 90,
        autoRollupEnabled: true,
        scheduleIntervalHours: 24,
      }),
    };

    adContextService = {
      getAllTags: jest.fn().mockResolvedValue([
        {
          id: 'tag-1',
          name: 'Artificial Intelligence',
          slug: 'artificial-intelligence',
          enabled: true,
          matchCount: 5,
          sendCount: 12,
        },
      ]),
      getTagStats: jest.fn().mockResolvedValue({
        totalTags: 1,
        enabledTags: 1,
        totalMatches: 5,
        totalSends: 12,
        topMatchedTags: [],
        topSentTags: [],
      }),
      createTag: jest.fn().mockResolvedValue({
        id: 'tag-2',
        name: 'Cybersecurity',
        slug: 'cybersecurity',
      }),
      updateTag: jest.fn().mockResolvedValue({
        id: 'tag-1',
        name: 'AI Updated',
        slug: 'artificial-intelligence',
      }),
      deleteTag: jest.fn().mockResolvedValue({ success: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: adminService },
        { provide: GraphRetentionService, useValue: retentionService },
        { provide: StorageService, useValue: storageService },
        { provide: PlansService, useValue: plansService },
        { provide: AdContextService, useValue: adContextService },
      ],
    })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AdminController>(AdminController);
  });

  describe('health and system', () => {
    it('returns system health status', async () => {
      const res = await controller.health();
      expect(res.status).toBe('ok');
      expect(adminService.health).toHaveBeenCalled();
    });

    it('returns public system status and maintenanceMode flag', async () => {
      const res = await controller.status();
      expect(res.status).toBe('ok');
      expect(res.maintenanceMode).toBe(false);
      expect(res.timestamp).toBeDefined();
      expect(adminService.getSystemSettings).toHaveBeenCalled();
    });

    it('returns system status and metrics', async () => {
      const res = await controller.getSystemStatus();
      expect(res.process.nodeVersion).toBe('v22.0.0');
      expect(adminService.getSystemStatus).toHaveBeenCalled();
    });

    it('returns storage proxy configuration and status', async () => {
      const res = await controller.getStorageProxyStatus();
      expect(res.isProxy).toBe(true);
      expect(res.upstreamProvider).toBe('s3');
      expect(storageService.getStorageProxyStatus).toHaveBeenCalled();
    });
  });

  describe('overview stats', () => {
    it('returns comprehensive business and system KPIs', async () => {
      const res = await controller.getOverviewStats();
      expect(res.users.total).toBe(100);
      expect(res.users.registered).toBe(90);
      expect(res.similarityQueue.occupation).toBe('low');
      expect(res.storageQuota.defaultStorageLimitMb).toBe(100);
      expect(adminService.getOverviewStats).toHaveBeenCalled();
    });
  });

  describe('user management', () => {
    it('returns paginated users list with filters', async () => {
      const res = await controller.getUsers(
        '1',
        '20',
        'test',
        'REGISTERED',
        'HIGH_USAGE',
        'ACTIVE',
      );
      expect(res.users).toHaveLength(1);
      expect(adminService.getUsers).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
        search: 'test',
        tier: 'REGISTERED',
        storageFilter: 'HIGH_USAGE',
        activityFilter: 'ACTIVE',
      });
    });

    it('returns detailed user profile', async () => {
      const res = await controller.getUserDetails('u-1');
      expect(res.user.id).toBe('u-1');
      expect(adminService.getUserDetails).toHaveBeenCalledWith('u-1');
    });

    it('updates user subscription and details', async () => {
      const res = await controller.updateUser('u-1', {
        subscriptionTier: 'REGISTERED',
      });
      expect(res.user.subscriptionTier).toBe('REGISTERED');
      expect(adminService.updateUser).toHaveBeenCalledWith('u-1', {
        subscriptionTier: 'REGISTERED',
      });
    });

    it('deletes user and cascades', async () => {
      const res = await controller.deleteUser('u-1');
      expect(res.deleted).toBe(true);
      expect(adminService.deleteUser).toHaveBeenCalledWith('u-1');
    });

    it('exports users in CSV format', async () => {
      const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
      } as unknown as Response;
      await controller.exportUsers(
        res,
        'csv',
        'alice',
        'REGISTERED',
        'HIGH_USAGE',
        'ACTIVE',
      );
      expect(adminService.exportUsers).toHaveBeenCalledWith({
        format: 'csv',
        search: 'alice',
        tier: 'REGISTERED',
        storageFilter: 'HIGH_USAGE',
        activityFilter: 'ACTIVE',
      });
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'text/csv; charset=utf-8',
      );
      expect(res.send).toHaveBeenCalledWith('User ID,Name\nu-1,Test User');
    });

    it('exports users in JSON format', async () => {
      adminService.exportUsers.mockResolvedValueOnce([{ id: 'u-1' }]);
      const res = {
        setHeader: jest.fn(),
        json: jest.fn(),
      } as unknown as Response;
      await controller.exportUsers(
        res,
        'json',
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(adminService.exportUsers).toHaveBeenCalledWith({
        format: 'json',
        search: undefined,
        tier: undefined,
        storageFilter: undefined,
        activityFilter: undefined,
      });
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/json; charset=utf-8',
      );
      expect(res.json).toHaveBeenCalledWith([{ id: 'u-1' }]);
    });

    it('executes batch user operations', async () => {
      const res = await controller.batchUsers({
        userIds: ['u-1', 'u-2'],
        action: 'set_tier',
        tier: 'REGISTERED',
      });
      expect(res.success).toBe(true);
      expect(adminService.batchUsers).toHaveBeenCalledWith({
        userIds: ['u-1', 'u-2'],
        action: 'set_tier',
        tier: 'REGISTERED',
      });
    });
  });

  describe('graph management', () => {
    it('returns paginated graphs list', async () => {
      const res = await controller.getGraphs(
        '1',
        '10',
        'Graph',
        'PUBLIC',
        'ALL',
      );
      expect(res.graphs).toHaveLength(1);
      expect(adminService.getGraphs).toHaveBeenCalledWith({
        page: 1,
        limit: 10,
        search: 'Graph',
        visibility: 'PUBLIC',
        retention: 'ALL',
      });
    });

    it('returns single graph details', async () => {
      const res = await controller.getGraphDetails('g-1');
      expect(res.id).toBe('g-1');
      expect(adminService.getGraphDetails).toHaveBeenCalledWith('g-1');
    });

    it('updates graph metadata', async () => {
      const res = await controller.updateGraph('g-1', {
        title: 'Updated Title',
      });
      expect(res.title).toBe('Updated Title');
      expect(adminService.updateGraph).toHaveBeenCalledWith('g-1', {
        title: 'Updated Title',
      });
    });

    it('updates graph canvas content', async () => {
      const res = await controller.updateGraphContent('g-1', {
        nodes: [{ id: 'n1' }],
        edges: [],
      });
      expect(res.id).toBe('g-1');
      expect(adminService.updateGraphContent).toHaveBeenCalledWith('g-1', {
        nodes: [{ id: 'n1' }],
        edges: [],
      });
    });

    it('deletes graph', async () => {
      const res = await controller.deleteGraph('g-1');
      expect(res.deleted).toBe(true);
      expect(adminService.deleteGraph).toHaveBeenCalledWith('g-1');
    });

    it('executes batch graph operations', async () => {
      const res = await controller.batchGraphs({
        graphIds: ['g-1', 'g-2'],
        action: 'set_retention_exempt',
        exempt: true,
      });
      expect(res.success).toBe(true);
      expect(adminService.batchGraphs).toHaveBeenCalledWith({
        graphIds: ['g-1', 'g-2'],
        action: 'set_retention_exempt',
        exempt: true,
      });
    });
  });

  describe('retention & cold storage', () => {
    it('executes sweep with dryRun=false by default', async () => {
      const res = await controller.runRetention(undefined, undefined);
      expect(retentionService.runRetentionSweep).toHaveBeenCalledWith({
        dryRun: false,
      });
      expect(res.dryRun).toBe(false);
    });

    it('executes dry-run sweep when query param dryRun=true', async () => {
      await controller.runRetention('true', undefined);
      expect(retentionService.runRetentionSweep).toHaveBeenCalledWith({
        dryRun: true,
      });
    });

    it('returns retention audit statistics', async () => {
      const res = await controller.getRetentionAudit();
      expect(res.totalActiveGraphs).toBe(10);
      expect(retentionService.getAuditStats).toHaveBeenCalled();
    });

    it('returns list of active archives', async () => {
      const res = await controller.getRetentionArchives();
      expect(res).toHaveLength(1);
      expect(retentionService.getArchives).toHaveBeenCalled();
    });

    it('downloads graph archive stream', async () => {
      retentionService.getArchiveByGraphId.mockResolvedValueOnce({
        id: 'arch-1',
        graphId: 'graph-1',
        title: 'Project Alpha',
        archiveUrl: 'archives/graphs/graph-1.tar.gz',
      });
      storageService.getObject.mockResolvedValueOnce({
        buffer: Buffer.from('mock archive content'),
        contentLength: 20,
      });
      const res = { set: jest.fn() } as unknown as Response;

      const file = await controller.downloadGraphArchive('graph-1', res);
      expect(file).toBeInstanceOf(StreamableFile);
      expect(res.set).toHaveBeenCalledWith({
        'Content-Type': 'application/gzip',
        'Content-Disposition':
          'attachment; filename="Project_Alpha_archive.tar.gz"',
        'Content-Length': '20',
      });
    });

    it('restores graph from archive as admin', async () => {
      retentionService.restoreGraphFromArchive.mockResolvedValueOnce({
        id: 'graph-1',
        restored: true,
      });

      const res = await controller.restoreGraphArchive('graph-1');
      expect(res.restored).toBe(true);
      expect(retentionService.restoreGraphFromArchive).toHaveBeenCalledWith(
        'graph-1',
        undefined,
        true,
      );
    });

    it('deletes cold storage archive', async () => {
      const res = await controller.deleteArchive('graph-1');
      expect(res.deleted).toBe(true);
      expect(adminService.deleteArchive).toHaveBeenCalledWith('graph-1');
    });
  });

  describe('user storage limits', () => {
    it('updates user storage limit and records audit event', async () => {
      const req = { identity: { userId: 'admin-1', role: 'admin' } } as any;
      const res = await controller.updateUserStorageLimit('u-1', 250, req);
      expect(res.storageLimitMb).toBe(250);
      expect(adminService.updateUserStorageLimit).toHaveBeenCalledWith(
        'u-1',
        250,
        { userId: 'admin-1', role: 'admin' },
      );
    });
  });

  describe('auth verification', () => {
    it('verifies admin session access', async () => {
      const req = { identity: { userId: 'admin-1', role: 'admin' } } as any;
      const res = await controller.verifyAdminAccess(req);
      expect(res.authorized).toBe(true);
      expect(res.identity?.role).toBe('admin');
    });
  });

  describe('system settings and dynamic limits', () => {
    it('retrieves system configuration and limits', async () => {
      const settings = await controller.getSettings();
      expect(settings.retentionDays).toBe(90);
      expect(settings.rateLimits.authenticatedPerMinute).toBe(120);
      expect(adminService.getSystemSettings).toHaveBeenCalled();
    });

    it('updates system configuration and returns new settings', async () => {
      const mockReq = {
        identity: { userId: 'admin-1', role: 'admin' },
      } as any;
      const updated = await controller.updateSettings(
        {
          retentionDays: 120,
          rateLimits: {
            anonymousPerMinute: 50,
            authenticatedPerMinute: 200,
            burstMultiplier: 3,
          },
          adConfig: {
            effectiveEcpm: 2.5,
            canvasAdDensity: 40,
            maxCanvasAds: 8,
          },
        },
        mockReq,
      );
      expect(updated.retentionDays).toBe(120);
      expect(updated.rateLimits.authenticatedPerMinute).toBe(200);
      expect(updated.adConfig.effectiveEcpm).toBe(2.5);
      expect(updated.adConfig.canvasAdDensity).toBe(40);
      expect(updated.adConfig.maxCanvasAds).toBe(8);
      expect(adminService.updateSystemSettings).toHaveBeenCalledWith(
        {
          retentionDays: 120,
          rateLimits: {
            anonymousPerMinute: 50,
            authenticatedPerMinute: 200,
            burstMultiplier: 3,
          },
          adConfig: {
            effectiveEcpm: 2.5,
            canvasAdDensity: 40,
            maxCanvasAds: 8,
          },
        },
        mockReq.identity,
      );
    });

    it('updates synonym configuration dictionary', async () => {
      const mockReq = {
        identity: { userId: 'admin-1', role: 'admin' },
      } as any;
      (adminService.updateSystemSettings as jest.Mock).mockResolvedValueOnce({
        retentionDays: 90,
        synonymsConfig: {
          hnsw: ['hierarchical navigable small world'],
        },
      });

      const updated = await controller.updateSettings(
        {
          synonymsConfig: {
            hnsw: ['hierarchical navigable small world'],
          },
        },
        mockReq,
      );
      expect(updated.synonymsConfig?.hnsw).toEqual([
        'hierarchical navigable small world',
      ]);
    });
  });

  describe('audit logs', () => {
    it('retrieves paginated audit logs with optional filters', async () => {
      const res = await controller.getAuditLogs(
        '1',
        '50',
        'system.maintenance_enable',
        'system',
      );
      expect(res.items).toHaveLength(1);
      expect(res.items[0]?.action).toBe('system.maintenance_enable');
      expect(adminService.getAuditLogs).toHaveBeenCalledWith({
        limit: 50,
        offset: 0,
        action: 'system.maintenance_enable',
        targetType: 'system',
      });
    });

    it('triggers manual audit log archival and returns archive details', async () => {
      const mockReq = {
        identity: { userId: 'admin-1', email: 'admin@test.com', role: 'admin' },
      } as any;
      const res = await controller.archiveAuditLogs(
        { olderThanDays: 30, retainCount: 100 },
        mockReq,
      );
      expect(res.id).toBe('arch-1');
      expect(res.eventCount).toBe(5);
      expect(adminService.archiveAuditLogs).toHaveBeenCalledWith(
        { olderThanDays: 30, retainCount: 100 },
        mockReq.identity,
      );
    });

    it('retrieves paginated cold storage audit archives', async () => {
      const res = await controller.getAuditArchives('1', '25');
      expect(res.items).toHaveLength(1);
      expect(res.items[0]?.id).toBe('arch-1');
      expect(adminService.getAuditArchives).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
      });
    });

    it('downloads cold storage audit archive file', async () => {
      const mockRes = {
        set: jest.fn(),
      } as unknown as Response;

      const file = await controller.downloadAuditArchive('arch-1', mockRes);
      expect(adminService.downloadAuditArchive).toHaveBeenCalledWith('arch-1');
      expect(mockRes.set).toHaveBeenCalledWith({
        'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="audit-log-1.json.gz"',
        'Content-Length': '9',
      });
      expect(file).toBeDefined();
    });

    it('previews cold storage audit archive contents with optional search and pagination', async () => {
      const res = await controller.previewAuditArchive(
        'arch-1',
        'role_change',
        '1',
        '10',
      );
      expect(res.archive.id).toBe('arch-1');
      expect(res.items).toHaveLength(1);
      expect(res.items[0]?.action).toBe('user.role_change');
      expect(adminService.getAuditArchiveContent).toHaveBeenCalledWith(
        'arch-1',
        {
          search: 'role_change',
          limit: 10,
          offset: 0,
        },
      );
    });
  });

  describe('plans management', () => {
    it('returns all plan definitions', async () => {
      const res = await controller.getPlans();
      expect(res).toHaveLength(2);
      expect(plansService.getPlanDefinitions).toHaveBeenCalled();
    });

    it('returns a single plan definition', async () => {
      const res = await controller.getPlan('REGISTERED');
      expect(res.tier).toBe('REGISTERED');
      expect(plansService.getPlanDefinition).toHaveBeenCalledWith('REGISTERED');
    });

    it('updates a plan definition and logs audit', async () => {
      adminService.recordAuditEvent = jest.fn().mockResolvedValue(undefined);
      const res = await controller.updatePlan('REGISTERED', {
        name: 'Registered Updated',
      });
      expect(res.tier).toBe('REGISTERED');
      expect(res.version).toBe(2);
      expect(plansService.updatePlanDefinition).toHaveBeenCalledWith(
        'REGISTERED',
        { name: 'Registered Updated' },
        undefined,
      );
    });

    it('gets ad analytics summary with optional range', async () => {
      const res = await controller.getAdAnalytics('7d');
      expect(res.totalImpressions).toBe(120);
      expect(res.totalCulled).toBe(40);
      expect(plansService.getAdAnalytics).toHaveBeenCalledWith({ range: '7d' });
    });

    it('exports ad telemetry as CSV', async () => {
      const mockRes = {
        setHeader: jest.fn(),
        send: jest.fn(),
      } as unknown as Response;

      await controller.exportAdTelemetry(mockRes, '30d');
      expect(plansService.exportAdTelemetryCsv).toHaveBeenCalledWith('30d');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'text/csv; charset=utf-8',
      );
      expect(mockRes.send).toHaveBeenCalledWith('id,eventType\n1,impression');
    });

    it('triggers ad telemetry daily rollup and logs audit', async () => {
      adminService.recordAuditEvent = jest.fn().mockResolvedValue(undefined);
      const res = await controller.triggerAdTelemetryRollup(
        { targetDate: '2026-09-16' },
        { identity: { userId: 'admin-1', role: 'admin' } } as any,
      );
      expect(res.success).toBe(true);
      expect(plansService.rollupAdTelemetryDaily).toHaveBeenCalledWith(
        '2026-09-16',
      );
      expect(adminService.recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ad_telemetry_rollup',
          targetType: 'system',
        }),
      );
    });

    it('purges old ad telemetry and logs audit event', async () => {
      adminService.recordAuditEvent = jest.fn().mockResolvedValue(undefined);
      const res = await controller.purgeOldAdTelemetry({ retentionDays: 90 }, {
        identity: { userId: 'admin-1', role: 'admin', email: 'admin@test.com' },
      } as any);
      expect(res).toEqual({
        success: true,
        purgedCount: 15,
        retentionDays: 90,
      });
      expect(plansService.purgeOldAdTelemetryEvents).toHaveBeenCalledWith(90);
      expect(adminService.recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ad_telemetry_purge',
          targetType: 'system',
          targetId: 'ad_telemetry',
          actorId: 'admin-1',
          actorEmail: 'admin@test.com',
          details: { success: true, purgedCount: 15, retentionDays: 90 },
        }),
      );
    });

    it('gets ad telemetry status', async () => {
      const res = await controller.getAdTelemetryStatus();
      expect(res).toEqual(
        expect.objectContaining({
          totalEventsCount: 100,
          totalRollupsCount: 10,
          retentionDays: 90,
          autoRollupEnabled: true,
          scheduleIntervalHours: 24,
        }),
      );
      expect(plansService.getAdTelemetryStatus).toHaveBeenCalled();
    });

    it('gets all ad context tags', async () => {
      const tags = await controller.getAdTags('true');
      expect(tags).toHaveLength(1);
      expect(adContextService.getAllTags).toHaveBeenCalledWith(true);
    });

    it('gets ad tag stats', async () => {
      const stats = await controller.getAdTagStats();
      expect(stats.totalTags).toBe(1);
      expect(adContextService.getTagStats).toHaveBeenCalled();
    });

    it('creates a new ad tag', async () => {
      const created = await controller.createAdTag({
        name: 'Cybersecurity',
        description: 'Info sec and encryption',
      });
      expect(created.slug).toBe('cybersecurity');
      expect(adContextService.createTag).toHaveBeenCalled();
    });

    it('updates an ad tag', async () => {
      const updated = await controller.updateAdTag('tag-1', {
        name: 'AI Updated',
      });
      expect(updated.name).toBe('AI Updated');
      expect(adContextService.updateTag).toHaveBeenCalledWith('tag-1', {
        name: 'AI Updated',
      });
    });

    it('deletes an ad tag', async () => {
      const res = await controller.deleteAdTag('tag-1');
      expect(res).toEqual({ success: true });
      expect(adContextService.deleteTag).toHaveBeenCalledWith('tag-1');
    });
  });
});
