import {
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';

import { auth } from '../../auth.js';
import { DatabaseService } from '../../common/services/database.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import type {
  AuthenticatedRequest,
  LimitsSummary,
  QueueOccupation,
  SubscriptionTier,
  ViewerIdentity,
} from '../../common/types.js';
import { PlansService } from '../plans/plans.service.js';
import type { ChangePasswordDto, UpdateProfileDto } from './auth.dto.js';

type AuthUser = {
  id: string;
  email: string;
  name: string;
  username?: string | null;
  isAnonymous?: boolean | null;
  subscriptionTier?: string | null;
  storageLimitMb?: number | null;
};

type IdentityRow = {
  id: string;
  email: string;
  name: string;
  username: string | null;
  isAnonymous: boolean;
  subscriptionTier: string | null;
  preferredLanguage: string;
  storageLimitMb?: number | null;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    @Optional() private readonly plans?: PlansService,
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
    const user = await this.database.one<{
      id: string;
      email: string;
      name: string;
      username: string | null;
      isAnonymous: boolean;
      subscriptionTier: string | null;
      preferredLanguage: string;
      storageLimitMb?: number | null;
    }>(
      `SELECT "id", "email", "name", "username", "isAnonymous", "subscriptionTier",
              "preferredLanguage", "storageLimitMb"
       FROM "User" WHERE "id" = $1`,
      [identity.userId],
    );
    if (!user) {
      throw new UnauthorizedException();
    }
    return {
      ...this.toIdentity(user),
      preferredLanguage: user.preferredLanguage,
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
       RETURNING "id", "email", "name", "username", "isAnonymous", "subscriptionTier", "preferredLanguage", "storageLimitMb"`,
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
    _identity: ViewerIdentity,
    _options?: {
      cost?: number;
      selectedNodeCount?: number;
      isCrawl?: boolean;
      crawlSteps?: number;
    },
  ): Promise<{
    remaining: number;
    deducted?: number;
    searchSpaceMultiplier?: number;
  }> {
    // Queries are free with no per-user hard blocking cap; global Weaviate throttling queue manages throughput
    return {
      remaining: 999999,
      deducted: 0,
      searchSpaceMultiplier: 1.0,
    };
  }

  async limits(identity: ViewerIdentity | undefined): Promise<LimitsSummary> {
    const viewer = this.requireIdentity(identity);
    const [graphRow, sourceRow, userStorageRow, settingsRow, userRow] =
      await Promise.all([
        this.database.one<{ total: string; privateCount: string }>(
          `SELECT 
             COUNT(*)::text AS "total",
             COUNT(*) FILTER (WHERE "isPublic" = false)::text AS "privateCount"
           FROM "Graph" WHERE "userId" = $1`,
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
        this.database.one<{ totalBytes: string }>(
          `SELECT COALESCE(SUM(s."sizeBytes"), 0)::text as "totalBytes"
           FROM "NodeSource" s
           JOIN "Graph" g ON g."id" = s."graphId"
           WHERE g."userId" = $1`,
          [viewer.userId],
        ),
        this.database.one<{ value: any }>(
          `SELECT "value" FROM "SystemSettings" WHERE "key" = 'storageConfig'`,
        ),
        this.database.one<{ storageLimitMb: number | null }>(
          'SELECT "storageLimitMb" FROM "User" WHERE "id" = $1',
          [viewer.userId],
        ),
      ]);

    const maxNodes = await this.database.one<{ maxCount: string }>(
      `SELECT COALESCE(MAX(jsonb_array_length("nodes")), 0)::text AS "maxCount"
       FROM "Graph" WHERE "userId" = $1`,
      [viewer.userId],
    );

    const usedBytes = Number(userStorageRow?.totalBytes || 0);
    const globalDefaultMb = Number(
      settingsRow?.value?.defaultStorageLimitMb ?? 100,
    );
    const limitMb = viewer.isGuest
      ? 0
      : (userRow?.storageLimitMb ?? globalDefaultMb);
    const limitBytes = limitMb * 1024 * 1024;
    const usedMb = Number((usedBytes / (1024 * 1024)).toFixed(2));

    let queueOccupation: QueueOccupation = 'low';
    if (this.redis) {
      const stored = await this.redis.get('queue:similarity:occupation');
      if (stored === 'low' || stored === 'mid' || stored === 'high') {
        queueOccupation = stored;
      }
    }

    return {
      tier: viewer.tier,
      storage: {
        usedBytes,
        limitBytes,
        usedMb,
        limitMb,
        exceeded: limitBytes > 0 && usedBytes >= limitBytes,
      },
      queueOccupation,
      canCreateGraphs: !viewer.isGuest && viewer.tier === 'REGISTERED',
      crawl: {
        allowedDepths: viewer.isGuest
          ? ['shallow']
          : ['shallow', 'default', 'deep'],
        maxStartingPoints: viewer.isGuest ? 1 : 100,
        comparativeModeAllowed: !viewer.isGuest,
      },
      graphs: this.limitStatus(
        Number(graphRow?.total ?? '0'),
        viewer.isGuest ? 0 : null,
      ),
      privateGraphs: this.limitStatus(
        Number(graphRow?.privateCount ?? '0'),
        viewer.isGuest ? 0 : null,
      ),
      queries: this.limitStatus(0, null),
      uploads: this.limitStatus(0, viewer.isGuest ? 0 : null),
      selectedNodes: this.limitStatus(0, viewer.isGuest ? 2 : null),
      nodesPerGraph: this.limitStatus(Number(maxNodes?.maxCount ?? '0'), null),
      sourcesPerNode: this.limitStatus(
        Number(sourceRow?.maxCount ?? '0'),
        null,
      ),
      sourceSizeBytes: this.limitStatus(
        0,
        viewer.isGuest ? 0 : 50 * 1024 * 1024,
      ),
      extendedContext: this.limitStatus(0, null),
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
    const adminEmails = (
      process.env.ADMIN_EMAILS ?? 'admin@viacarraria.com,admin@example.com'
    )
      .split(',')
      .map((e) => e.trim().toLowerCase());
    const isAdmin =
      !isGuest &&
      ((user as any).role === 'admin' ||
        (user.email && adminEmails.includes(user.email.toLowerCase())) ||
        user.email?.toLowerCase().endsWith('@admin.viacarraria.com') ||
        user.name === 'jbed94' ||
        user.username === 'jbed94');

    const identity: ViewerIdentity = {
      userId: user.id,
      email: user.email,
      username: user.username ?? user.name,
      isGuest,
      tier: isGuest ? 'ANONYMOUS' : this.toTier(user.subscriptionTier),
      role: isAdmin ? 'admin' : 'user',
      storageLimitMb:
        user.storageLimitMb !== undefined ? user.storageLimitMb : null,
    };
    return identity;
  }

  private toTier(value: string | null | undefined): SubscriptionTier {
    return value === 'ANONYMOUS' ? 'ANONYMOUS' : 'REGISTERED';
  }

  private limitStatus(used: number, limit: number | null) {
    return {
      used,
      limit,
      exceeded: limit !== null && used >= limit,
    };
  }
}
