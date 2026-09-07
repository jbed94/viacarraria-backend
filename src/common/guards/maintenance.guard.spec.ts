import {
  type ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

import type { RedisService } from '../services/redis.service.js';
import { isIpInCidr, MaintenanceGuard } from './maintenance.guard.js';

describe('MaintenanceGuard', () => {
  let guard: MaintenanceGuard;
  let mockRedis: jest.Mocked<Partial<RedisService>>;

  beforeEach(() => {
    mockRedis = {
      get: jest.fn(),
    };
    guard = new MaintenanceGuard(mockRedis as RedisService);
    delete process.env.ADMIN_KEY;
  });

  const createMockContext = (req: any): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    }) as unknown as ExecutionContext;

  it('allows access to /admin/health even during active maintenance', async () => {
    mockRedis.get = jest
      .fn()
      .mockResolvedValue(JSON.stringify({ maintenanceMode: true }));
    const ctx = createMockContext({
      path: '/api/admin/health',
      headers: {},
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows access to administrative routes (/admin/*) during active maintenance', async () => {
    mockRedis.get = jest
      .fn()
      .mockResolvedValue(JSON.stringify({ maintenanceMode: true }));
    const ctx = createMockContext({
      path: '/api/admin/settings',
      headers: {},
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows access to auth endpoints (/auth/*) during active maintenance', async () => {
    mockRedis.get = jest
      .fn()
      .mockResolvedValue(JSON.stringify({ maintenanceMode: true }));
    const ctx = createMockContext({
      path: '/api/auth/sign-in/email',
      headers: {},
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows access to status endpoints during active maintenance', async () => {
    mockRedis.get = jest
      .fn()
      .mockResolvedValue(JSON.stringify({ maintenanceMode: true }));
    const ctx = createMockContext({
      path: '/api/system/status',
      headers: {},
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows access if identity has role=admin during active maintenance', async () => {
    mockRedis.get = jest
      .fn()
      .mockResolvedValue(JSON.stringify({ maintenanceMode: true }));
    const ctx = createMockContext({
      path: '/api/graphs',
      headers: {},
      identity: { userId: 'admin-1', role: 'admin' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows access if valid X-Admin-Key is provided during active maintenance', async () => {
    process.env.ADMIN_KEY = 'secret-adm-key';
    mockRedis.get = jest
      .fn()
      .mockResolvedValue(JSON.stringify({ maintenanceMode: true }));
    const ctx = createMockContext({
      path: '/api/graphs',
      headers: { 'x-admin-key': 'secret-adm-key' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('blocks non-admin traffic with 503 when maintenanceMode is true', async () => {
    mockRedis.get = jest
      .fn()
      .mockResolvedValue(JSON.stringify({ maintenanceMode: true }));
    const ctx = createMockContext({
      path: '/api/graphs/my-graph',
      headers: {},
      identity: { userId: 'user-1', role: 'user' },
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);

    try {
      await guard.canActivate(ctx);
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      const res = httpError.getResponse() as any;
      expect(res.maintenance).toBe(true);
      expect(res.message).toBe('System undergoing scheduled maintenance');
    }
  });

  it('allows traffic when maintenanceMode is false', async () => {
    mockRedis.get = jest
      .fn()
      .mockResolvedValue(JSON.stringify({ maintenanceMode: false }));
    const ctx = createMockContext({
      path: '/api/graphs',
      headers: {},
      identity: { userId: 'user-1', role: 'user' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows traffic when system:settings does not exist in Redis', async () => {
    mockRedis.get = jest.fn().mockResolvedValue(null);
    const ctx = createMockContext({
      path: '/api/graphs',
      headers: {},
      identity: { userId: 'user-1', role: 'user' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('fails open if Redis read encounters an unexpected error', async () => {
    mockRedis.get = jest
      .fn()
      .mockRejectedValue(new Error('Redis connection timeout'));
    const ctx = createMockContext({
      path: '/api/graphs',
      headers: {},
      identity: { userId: 'user-1', role: 'user' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  describe('isIpInCidr utility', () => {
    it('accurately matches exact IPv4 and IPv6 addresses', () => {
      expect(isIpInCidr('127.0.0.1', '127.0.0.1')).toBe(true);
      expect(isIpInCidr('::1', '::1')).toBe(true);
      expect(isIpInCidr('::ffff:127.0.0.1', '127.0.0.1')).toBe(true);
      expect(isIpInCidr('192.168.1.10', '192.168.1.20')).toBe(false);
    });

    it('matches IPv4 subnets via CIDR masks', () => {
      expect(isIpInCidr('10.5.2.1', '10.0.0.0/8')).toBe(true);
      expect(isIpInCidr('10.255.255.254', '10.0.0.0/8')).toBe(true);
      expect(isIpInCidr('11.0.0.1', '10.0.0.0/8')).toBe(false);

      expect(isIpInCidr('192.168.1.45', '192.168.1.0/24')).toBe(true);
      expect(isIpInCidr('192.168.2.45', '192.168.1.0/24')).toBe(false);

      expect(isIpInCidr('172.16.50.2', '172.16.0.0/12')).toBe(true);
      expect(isIpInCidr('172.31.255.255', '172.16.0.0/12')).toBe(true);
      expect(isIpInCidr('172.32.0.1', '172.16.0.0/12')).toBe(false);
    });

    it('returns false for invalid CIDR prefixes or malformed IPs', () => {
      expect(isIpInCidr('192.168.1.1', '192.168.1.0/35')).toBe(false);
      expect(isIpInCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
      expect(isIpInCidr('10.0.0.1', 'invalid-prefix')).toBe(false);
    });
  });

  describe('Granular Maintenance Exemptions', () => {
    it('allows access if caller userId is in exemptUserIds', async () => {
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({
          maintenanceMode: true,
          maintenanceExemptions: {
            exemptUserIds: ['user-qa-tester', 'user-beta-vip'],
          },
        }),
      );
      const ctx = createMockContext({
        path: '/api/graphs',
        headers: {},
        identity: { userId: 'user-beta-vip', role: 'user' },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('allows access if caller IP is within allowedIps CIDR subnet', async () => {
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({
          maintenanceMode: true,
          maintenanceExemptions: {
            allowedIps: ['10.0.0.0/8', '192.168.100.0/24'],
          },
        }),
      );
      const ctx = createMockContext({
        path: '/api/graphs',
        headers: {},
        ip: '10.20.30.40',
        identity: { userId: 'regular-user', role: 'user' },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('allows access if x-forwarded-for IP matches allowed CIDR block', async () => {
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({
          maintenanceMode: true,
          maintenanceExemptions: {
            allowedIps: ['172.20.0.0/16'],
          },
        }),
      );
      const ctx = createMockContext({
        path: '/api/graphs',
        headers: { 'x-forwarded-for': '172.20.5.12, 10.0.0.1' },
        identity: { userId: 'regular-user', role: 'user' },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('allows access if caller has a custom exempt role', async () => {
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({
          maintenanceMode: true,
          maintenanceExemptions: {
            exemptRoles: ['admin', 'tester'],
          },
        }),
      );
      const ctx = createMockContext({
        path: '/api/graphs',
        headers: {},
        identity: { userId: 'user-tester-1', role: 'tester' },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('blocks request if neither IP, role, nor userId is exempt', async () => {
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({
          maintenanceMode: true,
          maintenanceExemptions: {
            allowedIps: ['192.168.1.0/24'],
            exemptUserIds: ['vip-1'],
            exemptRoles: ['admin'],
          },
        }),
      );
      const ctx = createMockContext({
        path: '/api/graphs',
        headers: {},
        ip: '8.8.8.8',
        identity: { userId: 'unauthorized-user', role: 'user' },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    });
  });
});
