import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../types.js';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // 1. Health and status checks are always public for k8s/monitoring
    if (
      request.path.endsWith('/admin/health') ||
      request.path.endsWith('/admin/status')
    ) {
      return true;
    }

    // 2. Allow X-Admin-Key authentication header
    const adminKeyHeader = request.headers['x-admin-key'];
    const expectedKey = process.env.ADMIN_KEY;
    if (expectedKey && adminKeyHeader === expectedKey) {
      return true;
    }

    // 3. Check ViewerIdentity resolved from Better Auth session
    const identity = request.identity;
    if (!identity) {
      throw new UnauthorizedException(
        'Authentication required to access administrative resources.',
      );
    }

    if (identity.role === 'admin') {
      return true;
    }

    throw new ForbiddenException(
      'Administrator privileges required to access this resource.',
    );
  }
}
