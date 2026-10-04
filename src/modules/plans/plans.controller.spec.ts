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

import { UnauthorizedException } from '@nestjs/common';
import { PlansController } from './plans.controller.js';
import type { PlansService } from './plans.service.js';
import type { AdContextService } from './ad-context.service.js';
import type { AdTelemetryDto } from './plans.dto.js';
import type { AuthenticatedRequest } from '../../common/types.js';

describe('PlansController', () => {
  let controller: PlansController;
  let mockPlansService: jest.Mocked<Partial<PlansService>>;
  let mockAdContextService: jest.Mocked<Partial<AdContextService>>;

  beforeEach(() => {
    mockPlansService = {
      getPlanDefinitions: jest.fn().mockResolvedValue([
        { tier: 'ANONYMOUS', name: 'Guest Tier' },
        { tier: 'FREE', name: 'Free Account' },
      ]),
      getPlanDefinition: jest.fn().mockResolvedValue({
        tier: 'PRO',
        name: 'Pro Tier',
      }),
      recordAdTelemetry: jest.fn().mockResolvedValue({ success: true }),
      getAdConfig: jest.fn().mockResolvedValue({
        effectiveEcpm: 1.5,
        canvasAdDensity: 35,
        maxCanvasAds: 5,
      }),
      getAdAnalytics: jest.fn().mockResolvedValue({
        impressions: 42,
        estimatedRevenue: 0.063,
      }),
    };

    mockAdContextService = {
      getGraphContextualTags: jest.fn().mockResolvedValue({
        graphId: 'graph-1',
        tags: ['artificial-intelligence'],
        details: [
          {
            id: 'tag-1',
            name: 'Artificial Intelligence',
            slug: 'artificial-intelligence',
            score: 1.0,
          },
        ],
      }),
      getActiveTags: jest.fn().mockResolvedValue([
        {
          id: 'tag-1',
          name: 'Artificial Intelligence',
          slug: 'artificial-intelligence',
          description: 'AI and ML tech',
          enabled: true,
        },
      ]),
    };

    controller = new PlansController(
      mockPlansService as PlansService,
      mockAdContextService as AdContextService,
    );
  });

  describe('getPlans', () => {
    it('returns plan definitions', async () => {
      const plans = await controller.getPlans();
      expect(plans).toHaveLength(2);
      expect(mockPlansService.getPlanDefinitions).toHaveBeenCalled();
    });
  });

  describe('getTransactions', () => {
    it('returns empty array', async () => {
      const txs = await controller.getTransactions();
      expect(txs).toEqual([]);
    });
  });

  describe('getMyPlan', () => {
    it('throws UnauthorizedException when identity is missing', async () => {
      const req = {} as AuthenticatedRequest;
      await expect(controller.getMyPlan(req)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('returns plan definition for authenticated user tier', async () => {
      const req = {
        identity: { tier: 'PRO', userId: 'user-1' },
      } as unknown as AuthenticatedRequest;

      const plan = await controller.getMyPlan(req);
      expect(plan).toEqual({ tier: 'PRO', name: 'Pro Tier' });
      expect(mockPlansService.getPlanDefinition).toHaveBeenCalledWith('PRO');
    });
  });

  describe('postAdTelemetry', () => {
    it('records telemetry event and returns success', async () => {
      const dto: AdTelemetryDto = {
        eventType: 'impression',
        format: 'card',
        durationSeconds: 15,
        consent: 'granted',
        slotId: 'slot-1',
        graphId: 'graph-1',
      };

      const result = await controller.postAdTelemetry(dto);
      expect(result).toEqual({ success: true });
      expect(mockPlansService.recordAdTelemetry).toHaveBeenCalledWith(dto);
    });

    it('handles minimal telemetry payload without optional properties', async () => {
      const dto: AdTelemetryDto = {
        eventType: 'culled',
      };

      const result = await controller.postAdTelemetry(dto);
      expect(result).toEqual({ success: true });
      expect(mockPlansService.recordAdTelemetry).toHaveBeenCalledWith(dto);
    });
  });

  describe('getAdConfig', () => {
    it('returns active ad configuration parameters', async () => {
      const config = await controller.getAdConfig();
      expect(config).toEqual({
        effectiveEcpm: 1.5,
        canvasAdDensity: 35,
        maxCanvasAds: 5,
      });
      expect(mockPlansService.getAdConfig).toHaveBeenCalled();
    });
  });

  describe('getAdAnalytics', () => {
    it('returns telemetry analytics filtered by range', async () => {
      const analytics = await controller.getAdAnalytics('30d');
      expect(analytics).toEqual({
        impressions: 42,
        estimatedRevenue: 0.063,
      });
      expect(mockPlansService.getAdAnalytics).toHaveBeenCalledWith({
        range: '30d',
      });
    });
  });

  describe('getAdContext', () => {
    it('returns contextual tags for specified graph', async () => {
      const context = await controller.getAdContext('graph-1');
      expect(context.tags).toEqual(['artificial-intelligence']);
      expect(mockAdContextService.getGraphContextualTags).toHaveBeenCalledWith(
        'graph-1',
      );
    });

    it('returns empty context when graphId is not provided', async () => {
      const context = await controller.getAdContext();
      expect(context).toEqual({ graphId: '', tags: [], details: [] });
    });
  });

  describe('getActiveTags', () => {
    it('returns active ad context tags', async () => {
      const tags = await controller.getActiveTags();
      expect(tags).toHaveLength(1);
      expect(tags[0]?.slug).toBe('artificial-intelligence');
      expect(mockAdContextService.getActiveTags).toHaveBeenCalled();
    });
  });
});
