import {
  type ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

import { AdminGuard } from './admin.guard.js';

describe('AdminGuard', () => {
  let guard: AdminGuard;

  beforeEach(() => {
    guard = new AdminGuard();
    delete process.env.ADMIN_KEY;
  });

  const createMockContext = (req: any): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    }) as unknown as ExecutionContext;

  it('allows access to public /admin/health route', () => {
    const ctx = createMockContext({
      path: '/api/v1/admin/health',
      headers: {},
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows access to public /admin/status route', () => {
    const ctx = createMockContext({
      path: '/api/v1/admin/status',
      headers: {},
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows access if valid X-Admin-Key header is supplied', () => {
    process.env.ADMIN_KEY = 'super-secret-admin-key';
    const ctx = createMockContext({
      path: '/api/v1/admin/users',
      headers: { 'x-admin-key': 'super-secret-admin-key' },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows access if identity has role=admin', () => {
    const ctx = createMockContext({
      path: '/api/v1/admin/overview',
      headers: {},
      identity: { userId: 'admin-1', role: 'admin' },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws UnauthorizedException if caller has no session and no admin key', () => {
    const ctx = createMockContext({
      path: '/api/v1/admin/overview',
      headers: {},
    });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws ForbiddenException if caller has user role without admin privileges', () => {
    const ctx = createMockContext({
      path: '/api/v1/admin/overview',
      headers: {},
      identity: { userId: 'user-1', role: 'user' },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
