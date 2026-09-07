import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

import { RedisService } from '../services/redis.service.js';
import type { AuthenticatedRequest } from '../types.js';

export function isIpInCidr(ip: string, cidrOrIp: string): boolean {
  let cleanIp = ip.trim();
  let cleanPattern = cidrOrIp.trim();

  // Normalize IPv4-mapped IPv6 e.g. ::ffff:192.168.1.1
  if (cleanIp.startsWith('::ffff:')) {
    cleanIp = cleanIp.slice(7);
  }
  if (cleanPattern.startsWith('::ffff:')) {
    cleanPattern = cleanPattern.slice(7);
  }

  // Exact match (covers IPv6 like ::1 or exact IPv4 like 127.0.0.1)
  if (cleanIp === cleanPattern) {
    return true;
  }

  // Handle IPv4 CIDR (e.g. 10.0.0.0/8, 192.168.1.0/24)
  if (cleanPattern.includes('/')) {
    const parts = cleanPattern.split('/');
    if (parts.length !== 2) return false;
    const patternIp = parts[0] ?? '';
    const prefixStr = parts[1] ?? '';
    const prefix = Number.parseInt(prefixStr, 10);
    if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }

    const ipParts = cleanIp.split('.').map(Number);
    const patternParts = patternIp.split('.').map(Number);

    if (ipParts.length !== 4 || patternParts.length !== 4) {
      return false;
    }
    if (ipParts.some(Number.isNaN) || patternParts.some(Number.isNaN)) {
      return false;
    }

    const ip0 = ipParts[0] ?? 0;
    const ip1 = ipParts[1] ?? 0;
    const ip2 = ipParts[2] ?? 0;
    const ip3 = ipParts[3] ?? 0;

    const pat0 = patternParts[0] ?? 0;
    const pat1 = patternParts[1] ?? 0;
    const pat2 = patternParts[2] ?? 0;
    const pat3 = patternParts[3] ?? 0;

    const ipNum = ((ip0 << 24) | (ip1 << 16) | (ip2 << 8) | ip3) >>> 0;
    const patternNum = ((pat0 << 24) | (pat1 << 16) | (pat2 << 8) | pat3) >>> 0;

    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipNum & mask) === (patternNum & mask);
  }

  return false;
}

@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const path = request.path || request.url || '';

    // 1. Health and status checks are always permitted
    if (
      path.endsWith('/admin/health') ||
      path.endsWith('/health') ||
      path.endsWith('/status') ||
      path.includes('/status')
    ) {
      return true;
    }

    // 2. Administrative endpoints are always permitted so admins can manage/un-toggle maintenance
    if (path.includes('/admin')) {
      return true;
    }

    // 3. Authentication endpoints are permitted so administrators and users can authenticate/check session
    if (path.includes('/auth')) {
      return true;
    }

    // 4. Requests with valid X-Admin-Key header bypass maintenance mode
    const adminKeyHeader = request.headers?.['x-admin-key'];
    const expectedKey = process.env.ADMIN_KEY;
    if (expectedKey && adminKeyHeader === expectedKey) {
      return true;
    }

    // 5. Authenticated administrators bypass maintenance mode by default
    if (request.identity?.role === 'admin') {
      return true;
    }

    // 6. Query dynamic system settings and granular exemptions from Redis
    try {
      const raw = await this.redis.get('system:settings');
      if (raw) {
        const settings = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (settings?.maintenanceMode === true) {
          const exemptions = settings.maintenanceExemptions;

          // 6a. Role check (e.g. ['admin', 'beta_tester'])
          const allowedRoles: string[] = exemptions?.exemptRoles?.length
            ? exemptions.exemptRoles
            : ['admin'];
          if (
            request.identity?.role &&
            allowedRoles.includes(request.identity.role)
          ) {
            return true;
          }

          // 6b. User ID allowlist (e.g. VIP test users, QA accounts)
          if (
            request.identity?.userId &&
            Array.isArray(exemptions?.exemptUserIds) &&
            exemptions.exemptUserIds.includes(request.identity.userId)
          ) {
            return true;
          }

          // 6c. IP / CIDR allowlist (e.g. office IP, VPN subnet 10.0.0.0/8)
          const clientIp =
            (request.headers?.['x-forwarded-for'] as string)
              ?.split(',')[0]
              ?.trim() ||
            request.ip ||
            request.socket?.remoteAddress ||
            '';

          if (
            clientIp &&
            Array.isArray(exemptions?.allowedIps) &&
            exemptions.allowedIps.length > 0
          ) {
            const isAllowedIp = exemptions.allowedIps.some((cidr: string) =>
              isIpInCidr(clientIp, cidr),
            );
            if (isAllowedIp) {
              return true;
            }
          }

          throw new HttpException(
            {
              statusCode: HttpStatus.SERVICE_UNAVAILABLE,
              message: 'System undergoing scheduled maintenance',
              maintenance: true,
            },
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }
      }
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      // Fail open on Redis connectivity errors so transient failures do not bring down traffic
    }

    return true;
  }
}
