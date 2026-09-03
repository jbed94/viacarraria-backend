import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Response } from 'express';

import { UpstashRateLimitService } from '../services/upstash-rate-limit.service.js';
import type { AuthenticatedRequest } from '../types.js';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly rateLimit: UpstashRateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    if (request.path.endsWith('/admin/health')) return true;

    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const identifier = request.identity?.userId ?? `ip:${ip}`;
    const kind = request.path.endsWith('/search') ? 'search' : 'request';
    const result = await this.rateLimit.limit(
      kind,
      identifier,
      ip,
      request.get('user-agent'),
    );

    response.setHeader('X-RateLimit-Limit', result.limit);
    response.setHeader('X-RateLimit-Remaining', result.remaining);
    response.setHeader('X-RateLimit-Reset', result.reset);
    if (!result.success) {
      throw new HttpException(
        'Too many requests. Please try again shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
