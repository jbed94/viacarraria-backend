import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';

import { auth } from '../../auth.js';
import { DatabaseService } from '../../common/services/database.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import type {
  AuthenticatedRequest,
  LimitsSummary,
  SubscriptionTier,
  ViewerIdentity,
} from '../../common/types.js';
import type { ChangePasswordDto, UpdateProfileDto } from './auth.dto.js';

type AuthUser = {
  id: string;
  email: string;
  name: string;
  username?: string | null;
  isAnonymous?: boolean | null;
  subscriptionTier?: string | null;
};

type IdentityRow = {
  id: string;
  email: string;
  name: string;
  username: string | null;
  isAnonymous: boolean;
  subscriptionTier: string | null;
  preferredLanguage: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async resolveIdentity(
    request: AuthenticatedRequest,
  ): Promise<ViewerIdentity | undefined> {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    return session ? this.toIdentity(session.user) : undefined;
  }

  async profile(
    identity: ViewerIdentity,
  ): Promise<ViewerIdentity & { preferredLanguage: string }> {
    this.requireRegistered(identity);
    const row = await this.database.one<IdentityRow>(
      `SELECT "id", "email", "name", "username", "isAnonymous", "subscriptionTier", "preferredLanguage"
       FROM "User" WHERE "id" = $1`,
      [identity.userId],
    );
    if (!row) {
      throw new UnauthorizedException();
    }
    return {
      ...this.toIdentity(row),
      preferredLanguage: row.preferredLanguage,
    };
  }

  async updateProfile(
    identity: ViewerIdentity,
    dto: UpdateProfileDto,
  ): Promise<ViewerIdentity & { preferredLanguage: string }> {
    this.requireRegistered(identity);
    const current = await this.profile(identity);
    const username = dto.username?.trim() ?? current.username ?? current.email;
    const preferredLanguage =
      dto.preferredLanguage?.trim().toLowerCase() ?? current.preferredLanguage;
    const [row] = await this.database.query<IdentityRow>(
      `UPDATE "User" SET "name" = $1, "username" = $1, "preferredLanguage" = $2, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $3
       RETURNING "id", "email", "name", "username", "isAnonymous", "subscriptionTier", "preferredLanguage"`,
      [username, preferredLanguage, identity.userId],
    );
    if (!row) {
      throw new UnauthorizedException();
    }
    return {
      ...this.toIdentity(row),
      preferredLanguage: row.preferredLanguage,
    };
  }

  async changePassword(
    identity: ViewerIdentity,
    request: AuthenticatedRequest,
    dto: ChangePasswordDto,
  ): Promise<void> {
    this.requireRegistered(identity);
    try {
      await auth.api.changePassword({
        body: {
          currentPassword: dto.currentPassword,
          newPassword: dto.newPassword,
          revokeOtherSessions: true,
        },
        headers: fromNodeHeaders(request.headers),
      });
    } catch {
      throw new UnauthorizedException('Current password is incorrect.');
    }
  }

  async sessions(
    identity: ViewerIdentity,
  ): Promise<
    Array<{ id: string; expiresAt: Date; lastUsedAt: Date; createdAt: Date }>
  > {
    this.requireRegistered(identity);
    return this.database.query(
      `SELECT "id", "expiresAt", "updatedAt" AS "lastUsedAt", "createdAt" FROM "Session"
       WHERE "userId" = $1 AND "expiresAt" > CURRENT_TIMESTAMP ORDER BY "updatedAt" DESC`,
      [identity.userId],
    );
  }

  async revokeSession(
    identity: ViewerIdentity,
    request: AuthenticatedRequest,
    sessionId: string,
  ): Promise<void> {
    this.requireRegistered(identity);
    const session = await this.database.one<{ token: string }>(
      'SELECT "token" FROM "Session" WHERE "id" = $1 AND "userId" = $2',
      [sessionId, identity.userId],
    );
    if (!session) {
      throw new NotFoundException('Session not found.');
    }
    await auth.api.revokeSession({
      body: { token: session.token },
      headers: fromNodeHeaders(request.headers),
    });
  }

  async deleteProfile(
    identity: ViewerIdentity,
    request: AuthenticatedRequest,
  ): Promise<void> {
    this.requireRegistered(identity);
    await auth.api.deleteUser({
      body: {},
      headers: fromNodeHeaders(request.headers),
    });
  }

  async consumeQueryQuota(
    identity: ViewerIdentity,
  ): Promise<{ remaining: number }> {
    const limit =
      identity.tier === 'ANONYMOUS' ? 3 : identity.tier === 'FREE' ? 20 : 1000;
    const quota = await this.redis.consumeQuota(identity.userId, limit);
    if (!quota.allowed) {
      throw new HttpException(
        'Daily query budget reached.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return { remaining: quota.remaining };
  }

  async limits(identity: ViewerIdentity | undefined): Promise<LimitsSummary> {
    const viewer = this.requireIdentity(identity);
    const [graphRow, sourceRow, queryUsage, uploadUsage] = await Promise.all([
      this.database.one<{ count: string }>(
        'SELECT COUNT(*)::text AS "count" FROM "Graph" WHERE "userId" = $1',
        [viewer.userId],
      ),
      this.database.one<{ maxCount: string }>(
        `SELECT COALESCE(MAX("sourceCount"), 0)::text AS "maxCount"
         FROM (
           SELECT COUNT(*) AS "sourceCount"
           FROM "NodeSource" s JOIN "Graph" g ON g."id" = s."graphId"
           WHERE g."userId" = $1 GROUP BY s."graphId", s."nodeId"
         ) counts`,
        [viewer.userId],
      ),
      this.redis.getDailyUsage(viewer.userId),
      this.redis.getHourlyUploadUsage(viewer.userId),
    ]);
    const maxNodes = await this.database.one<{ maxCount: string }>(
      `SELECT COALESCE(MAX(jsonb_array_length("nodes")), 0)::text AS "maxCount"
       FROM "Graph" WHERE "userId" = $1`,
      [viewer.userId],
    );
    const graphLimit = viewer.isGuest ? 0 : viewer.tier === 'FREE' ? 3 : null;
    const queryLimit =
      viewer.tier === 'ANONYMOUS' ? 3 : viewer.tier === 'FREE' ? 20 : 1000;
    const uploadLimit = viewer.isGuest ? 0 : 10;
    const nodeLimit = viewer.isGuest ? 0 : viewer.tier === 'FREE' ? 10 : null;
    const sourceLimit = viewer.isGuest ? 0 : viewer.tier === 'FREE' ? 3 : null;
    const fileSizeLimit = viewer.isGuest
      ? 0
      : viewer.tier === 'FREE'
        ? 2 * 1024 * 1024
        : 25 * 1024 * 1024;
    const extendedLimit =
      viewer.tier === 'ANONYMOUS' ? 0 : viewer.tier === 'FREE' ? 3 : 15;
    return {
      tier: viewer.tier,
      graphs: this.limitStatus(Number(graphRow?.count ?? '0'), graphLimit),
      queries: this.limitStatus(queryUsage, queryLimit),
      uploads: this.limitStatus(uploadUsage, uploadLimit),
      selectedNodes: this.limitStatus(0, viewer.isGuest ? 2 : viewer.tier === 'FREE' ? 10 : null),
      nodesPerGraph: this.limitStatus(
        Number(maxNodes?.maxCount ?? '0'),
        nodeLimit,
      ),
      sourcesPerNode: this.limitStatus(
        Number(sourceRow?.maxCount ?? '0'),
        sourceLimit,
      ),
      sourceSizeBytes: this.limitStatus(0, fileSizeLimit),
      extendedContext: this.limitStatus(0, extendedLimit),
    };
  }

  requireIdentity(identity: ViewerIdentity | undefined): ViewerIdentity {
    if (!identity) {
      throw new UnauthorizedException('A session is required for this action.');
    }
    return identity;
  }

  requireRegistered(identity: ViewerIdentity): ViewerIdentity {
    if (identity.isGuest) {
      throw new UnauthorizedException(
        'Create an account to access this action.',
      );
    }
    return identity;
  }

  private toIdentity(user: AuthUser | IdentityRow): ViewerIdentity {
    const isGuest = user.isAnonymous === true;
    return {
      userId: user.id,
      email: user.email,
      username: user.username ?? user.name,
      isGuest,
      tier: isGuest ? 'ANONYMOUS' : this.toTier(user.subscriptionTier),
    };
  }

  private toTier(value: string | null | undefined): SubscriptionTier {
    return value === 'PRO' || value === 'FREE' || value === 'ANONYMOUS'
      ? value
      : 'FREE';
  }

  private limitStatus(used: number, limit: number | null) {
    return {
      used,
      limit,
      exceeded: limit !== null && used >= limit,
    };
  }
}
