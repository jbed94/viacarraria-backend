jest.mock('better-auth', () => ({ betterAuth: jest.fn() }));
jest.mock('better-auth/plugins', () => ({ anonymous: jest.fn() }));
jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn() }));
jest.mock('../../auth.js', () => ({
  auth: { api: {} },
  authDatabase: { query: jest.fn() },
}));

import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { DatabaseService } from '../../common/services/database.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import { PlansService } from './plans.service.js';

describe('PlansService', () => {
  let service: PlansService;
  let database: { query: jest.Mock; one: jest.Mock };
  let redis: { get: jest.Mock; set: jest.Mock; publish: jest.Mock };

  beforeEach(async () => {
    database = {
      query: jest.fn(),
      one: jest.fn(),
    };
    redis = {
      get: jest.fn().mockResolvedValue(
        JSON.stringify({
          adConfig: {
            effectiveEcpm: 1.5,
            canvasAdDensity: 35,
            maxCanvasAds: 5,
          },
        }),
      ),
      set: jest.fn(),
      publish: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlansService,
        { provide: DatabaseService, useValue: database },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get<PlansService>(PlansService);
  });

  describe('getPlanDefinitions', () => {
    it('returns canonical plan definitions from database', async () => {
      database.query.mockResolvedValueOnce([
        {
          id: 'plan-anon',
          tier: 'ANONYMOUS',
          name: 'Anonymous Guest',
          description: 'Guest exploration',
          adsEnabled: true,
          limits: { maxNodes: 0, maxSelectedNodes: 2 },
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'plan-reg',
          tier: 'REGISTERED',
          name: 'Registered Member',
          description: 'Full knowledge graph features',
          adsEnabled: true,
          limits: { maxNodes: null, maxSelectedNodes: null },
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const plans = await service.getPlanDefinitions();
      expect(plans).toHaveLength(2);
      expect(plans[0]!.tier).toBe('ANONYMOUS');
      expect(plans[1]!.tier).toBe('REGISTERED');
    });

    it('returns fallback definitions if table is empty', async () => {
      database.query.mockResolvedValueOnce([]);

      const plans = await service.getPlanDefinitions();
      expect(plans).toHaveLength(2);
      expect(plans.map((p) => p.tier)).toEqual(['ANONYMOUS', 'REGISTERED']);
    });
  });

  describe('getPlanDefinition', () => {
    it('returns requested plan definition by tier', async () => {
      database.one.mockResolvedValueOnce({
        id: 'plan-reg',
        tier: 'REGISTERED',
        name: 'Registered Member',
        description: 'Full knowledge graph features',
        adsEnabled: true,
        limits: {},
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const plan = await service.getPlanDefinition('registered');
      expect(plan.tier).toBe('REGISTERED');
    });

    it('returns fallback if not found in database', async () => {
      database.one.mockResolvedValueOnce(null);

      const plan = await service.getPlanDefinition('ANONYMOUS');
      expect(plan.tier).toBe('ANONYMOUS');
    });

    it('throws NotFoundException for unknown tier', async () => {
      database.one.mockResolvedValueOnce(null);

      await expect(service.getPlanDefinition('UNKNOWN')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updatePlanDefinition', () => {
    it('rejects invalid plan tier with BadRequestException', async () => {
      await expect(
        service.updatePlanDefinition('PRO', { name: 'Pro Plan' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('updates REGISTERED plan and increments version', async () => {
      database.one.mockResolvedValueOnce({
        id: 'plan-reg',
        tier: 'REGISTERED',
        name: 'Registered Member',
        description: 'Existing',
        adsEnabled: true,
        limits: {},
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      database.query.mockResolvedValueOnce([
        {
          id: 'plan-reg',
          tier: 'REGISTERED',
          name: 'Updated Member',
          description: 'Updated Description',
          adsEnabled: true,
          limits: {},
          version: 2,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const result = await service.updatePlanDefinition('REGISTERED', {
        name: 'Updated Member',
        description: 'Updated Description',
      });

      expect(result.tier).toBe('REGISTERED');
      expect(result.version).toBe(2);
      expect(result.name).toBe('Updated Member');
    });
  });

  describe('ad telemetry & analytics', () => {
    it('records ad telemetry event into database', async () => {
      database.query.mockResolvedValueOnce([]);

      const res = await service.recordAdTelemetry({
        eventType: 'impression',
        format: 'card',
        durationSeconds: 12.5,
        consent: 'granted',
        slotId: 'results-sidebar-ad-1',
        graphId: 'graph-test-1',
      });

      expect(res.success).toBe(true);
      expect(database.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "AdTelemetryEvent"'),
        expect.arrayContaining([
          'impression',
          'card',
          12.5,
          'granted',
          'results-sidebar-ad-1',
          'graph-test-1',
        ]),
      );
    });

    it('executes ad telemetry daily rollup successfully', async () => {
      database.query.mockResolvedValueOnce([
        { id: 'rollup-1' },
        { id: 'rollup-2' },
      ]);

      const res = await service.rollupAdTelemetryDaily('2026-09-16');

      expect(res.success).toBe(true);
      expect(res.targetDate).toBe('2026-09-16');
      expect(res.rowsRolledUp).toBe(2);
      expect(database.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "AdTelemetryDailyRollup"'),
        ['2026-09-16'],
      );
    });

    it('aggregates ad analytics metrics correctly combining rollups and events', async () => {
      // 1. Rollup query returns pre-aggregated historical rows
      database.query.mockResolvedValueOnce([
        {
          eventType: 'impression',
          consent: 'granted',
          count: 60,
          totalDuration: 900,
        },
      ]);
      // 2. Event query returns live events
      database.query.mockResolvedValueOnce([
        {
          eventType: 'impression',
          consent: 'granted',
          count: 40,
          totalDuration: 600,
        },
        { eventType: 'culled', consent: null, count: 50, totalDuration: 0 },
        {
          eventType: 'viewable_pulse',
          consent: null,
          count: 200,
          totalDuration: 1000,
        },
        { eventType: 'refresh', consent: null, count: 30, totalDuration: 0 },
        {
          eventType: 'consent',
          consent: 'essential_only',
          count: 20,
          totalDuration: 0,
        },
      ]);
      // 3. Top graphs query
      database.query.mockResolvedValueOnce([
        {
          graphId: 'graph-1',
          graphName: 'Quantum Mechanics',
          isPublic: true,
          impressions: 80,
          activeViewableSeconds: 2000,
        },
      ]);

      const analytics = await service.getAdAnalytics();

      expect(analytics.totalImpressions).toBe(100); // 60 + 40
      expect(analytics.totalCulled).toBe(50);
      expect(analytics.totalActiveViewableSeconds).toBe(2500); // 900 + 600 + 1000
      expect(analytics.averageViewabilitySeconds).toBe(25); // 2500 / 100
      expect(analytics.gpuSavingsPercentage).toBe(33.3); // 50 / (100 + 50)
      expect(analytics.estimatedRevenueUsd).toBe(0.15); // (100 / 1000) * 1.50
      expect(analytics.consentBreakdown.personalized).toBe(100);
      expect(analytics.consentBreakdown.contextual).toBe(20);
      expect(analytics.range).toBe('all');
      expect(analytics.topGraphs).toHaveLength(1);
      expect(analytics.topGraphs![0]!.graphId).toBe('graph-1');
      expect(analytics.topGraphs![0]!.graphName).toBe('Quantum Mechanics');
      expect(analytics.topGraphs![0]!.estimatedRevenueUsd).toBe(0.12);
    });

    it('filters ad analytics by date range (7d, 30d, 90d)', async () => {
      database.query.mockResolvedValueOnce([]);
      database.query.mockResolvedValueOnce([
        {
          eventType: 'impression',
          consent: 'granted',
          count: 40,
          totalDuration: 600,
        },
      ]);
      database.query.mockResolvedValueOnce([]);

      const analytics = await service.getAdAnalytics({ range: '7d' });
      expect(analytics.totalImpressions).toBe(40);
      expect(analytics.range).toBe('7d');
      expect(database.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'WHERE "createdAt" >= NOW() - INTERVAL \'7 days\'',
        ),
        expect.any(Array),
      );
    });

    it('exports ad telemetry as properly formatted CSV string', async () => {
      database.query.mockResolvedValueOnce([
        {
          id: 'ev-1',
          eventType: 'impression',
          format: 'card',
          durationSeconds: 15.0,
          consent: 'granted',
          slotId: 'slot-banner-1',
          graphId: 'graph-alpha',
          createdAt: new Date('2026-09-17T01:00:00.000Z'),
        },
        {
          id: 'ev-2',
          eventType: 'culled',
          format: 'horizontal',
          durationSeconds: 0,
          consent: null,
          slotId: 'slot-banner-2',
          graphId: null,
          createdAt: '2026-09-17T01:05:00.000Z',
        },
      ]);

      const csv = await service.exportAdTelemetryCsv('30d');
      expect(csv).toContain(
        'id,eventType,format,durationSeconds,consent,slotId,graphId,createdAt',
      );
      expect(csv).toContain(
        '"ev-1","impression","card",15.0,"granted","slot-banner-1","graph-alpha"',
      );
      expect(csv).toContain(
        '"ev-2","culled","horizontal",0.0,"","slot-banner-2",""',
      );
      expect(database.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'WHERE "createdAt" >= NOW() - INTERVAL \'30 days\'',
        ),
      );
    });

    it('safely purges old ad telemetry events that have been aggregated into daily rollups', async () => {
      database.query.mockResolvedValueOnce([
        { id: 'ev-old-1' },
        { id: 'ev-old-2' },
      ]);

      const res = await service.purgeOldAdTelemetryEvents(90);

      expect(res.success).toBe(true);
      expect(res.purgedCount).toBe(2);
      expect(res.retentionDays).toBe(90);
      expect(database.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM "AdTelemetryEvent"'),
        [90],
      );
    });

    it('retrieves ad telemetry storage and aggregation status', async () => {
      database.query
        .mockResolvedValueOnce([
          {
            count: 1500,
            minDate: new Date('2026-06-01T00:00:00Z'),
            maxDate: new Date('2026-09-17T12:00:00Z'),
          },
        ])
        .mockResolvedValueOnce([
          {
            count: 85,
            lastDate: '2026-09-16',
          },
        ]);

      const status = await service.getAdTelemetryStatus();

      expect(status.totalEventsCount).toBe(1500);
      expect(status.totalRollupsCount).toBe(85);
      expect(status.oldestEventDate).toContain('2026-06-01');
      expect(status.newestEventDate).toContain('2026-09-17');
      expect(status.lastRollupDate).toBe('2026-09-16');
      expect(status.retentionDays).toBe(90);
      expect(status.autoRollupEnabled).toBe(true);
      expect(status.scheduleIntervalHours).toBe(24);
    });

    it('initializes and destroys periodic rollup scheduled task', async () => {
      service.onModuleInit();
      expect((service as any).timer).toBeDefined();

      const runSpy = jest
        .spyOn(service, 'runScheduledRollupAndRetention')
        .mockResolvedValueOnce({
          rollup: { success: true, rowsRolledUp: 5 },
          retention: { success: true, purgedCount: 0, retentionDays: 90 },
        });

      const res = await service.runScheduledRollupAndRetention();
      expect(res.rollup.success).toBe(true);
      expect(res.retention.success).toBe(true);
      expect(runSpy).toHaveBeenCalled();

      service.onModuleDestroy();
      expect((service as any).timer).toBeNull();
    });
  });

  describe('getAdConfig', () => {
    it('returns ad configuration from redis system settings', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({
          adConfig: {
            effectiveEcpm: 2.0,
            canvasAdDensity: 40,
            maxCanvasAds: 8,
          },
        }),
      );
      const config = await service.getAdConfig();
      expect(config.effectiveEcpm).toBe(2.0);
      expect(config.canvasAdDensity).toBe(40);
      expect(config.maxCanvasAds).toBe(8);
    });

    it('falls back to database query if not in redis', async () => {
      redis.get.mockResolvedValueOnce(null);
      database.query.mockResolvedValueOnce([
        {
          value: {
            effectiveEcpm: 3.0,
            canvasAdDensity: 50,
            maxCanvasAds: 10,
          },
        },
      ]);
      const config = await service.getAdConfig();
      expect(config.effectiveEcpm).toBe(3.0);
      expect(config.canvasAdDensity).toBe(50);
      expect(config.maxCanvasAds).toBe(10);
    });
  });
});
