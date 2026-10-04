import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { gunzipSync, gzipSync } from 'node:zlib';

import { DatabaseService } from '../../common/services/database.service.js';
import { RabbitMqService } from '../../common/services/rabbitmq.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import { StorageService } from '../../common/services/storage.service.js';
import { WeaviateService } from '../../common/services/weaviate.service.js';
import { SimilarityQueueService } from '../../common/services/similarity-queue.service.js';
import type {
  AdminGraphDetailsRow,
  AdminGraphInspectionRow,
  AdminSourceInspectionRow,
  AdminUserDetailsRow,
  AdminUserExportRow,
  AdminUserGraphRow,
  AdminUserRecentQueryRow,
  AdminUserRow,
  ViewerIdentity,
} from '../../common/types.js';

@Injectable()
export class AdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly rabbitMq: RabbitMqService,
    private readonly weaviate: WeaviateService,
    private readonly storage: StorageService,
    @Optional() private readonly similarityQueue?: SimilarityQueueService,
  ) {}

  async health(): Promise<{
    status: 'ok' | 'degraded';
    services: Record<string, boolean>;
  }> {
    const database = await this.database
      .query<{ ok: number }>('SELECT 1 AS ok')
      .then(() => true)
      .catch(() => false);
    const [redis, rabbitMq, weaviate] = await Promise.all([
      this.redis.ping(),
      this.rabbitMq.isAvailable(),
      this.weaviate.isReady(),
    ]);
    const services = { database, redis, rabbitMq, weaviate };
    return { status: database ? 'ok' : 'degraded', services };
  }

  async getSystemStatus() {
    const health = await this.health();
    const storageProxy = await this.storage.getStorageProxyStatus();
    const memory = process.memoryUsage();

    return {
      health,
      storageProxy,
      process: {
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        memoryMb: {
          rss: Math.round(memory.rss / (1024 * 1024)),
          heapTotal: Math.round(memory.heapTotal / (1024 * 1024)),
          heapUsed: Math.round(memory.heapUsed / (1024 * 1024)),
        },
        env: process.env.NODE_ENV ?? 'development',
      },
    };
  }

  async getOverviewStats() {
    const [userCounts, graphCounts, storageCounts, queryCounts, hourlyQueries] =
      await Promise.all([
        this.database.one<{
          totalUsers: string;
          registeredUsers: string;
          anonymousUsers: string;
          newUsers30d: string;
        }>(`
        SELECT
          COUNT(*)::text AS "totalUsers",
          COUNT(*) FILTER (WHERE "subscriptionTier" = 'REGISTERED' AND "isAnonymous" = false)::text AS "registeredUsers",
          COUNT(*) FILTER (WHERE "isAnonymous" = true OR "subscriptionTier" = 'ANONYMOUS')::text AS "anonymousUsers",
          COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '30 days')::text AS "newUsers30d"
        FROM "User"
      `),
        this.database.one<{
          totalGraphs: string;
          publicGraphs: string;
          privateGraphs: string;
          activeGraphs: string;
          inactiveGraphs: string;
          scheduledDeletionGraphs: string;
          exemptGraphs: string;
        }>(`
        SELECT
          COUNT(*)::text AS "totalGraphs",
          COUNT(*) FILTER (WHERE "isPublic" = true)::text AS "publicGraphs",
          COUNT(*) FILTER (WHERE "isPublic" = false)::text AS "privateGraphs",
          COUNT(*) FILTER (WHERE "lastAccessedAt" >= NOW() - INTERVAL '90 days')::text AS "activeGraphs",
          COUNT(*) FILTER (WHERE "lastAccessedAt" < NOW() - INTERVAL '90 days')::text AS "inactiveGraphs",
          COUNT(*) FILTER (WHERE "scheduledForDeletionAt" IS NOT NULL)::text AS "scheduledDeletionGraphs",
          COUNT(*) FILTER (WHERE "isExemptFromRetention" = true)::text AS "exemptGraphs"
        FROM "Graph"
      `),
        this.database.one<{
          totalSources: string;
          totalStorageBytes: string;
          archivesCount: string;
          archivesBytes: string;
        }>(`
        SELECT
          (SELECT COUNT(*)::text FROM "NodeSource") AS "totalSources",
          (SELECT COALESCE(SUM("sizeBytes"), 0)::text FROM "NodeSource") AS "totalStorageBytes",
          (SELECT COUNT(*)::text FROM "GraphArchive") AS "archivesCount",
          (SELECT COALESCE(SUM("sizeBytes"), 0)::text FROM "GraphArchive") AS "archivesBytes"
      `),
        this.database.one<{
          totalQueries: string;
          queriesToday: string;
          queriesLastHour: string;
        }>(`
        SELECT
          COUNT(*)::text AS "totalQueries",
          COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '24 hours')::text AS "queriesToday",
          COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '1 hour')::text AS "queriesLastHour"
        FROM "Query"
      `),
        this.database.query<{ hour: string; count: string }>(`
        SELECT
          to_char(date_trunc('hour', "createdAt"), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS "hour",
          COUNT(*)::text AS "count"
        FROM "Query"
        WHERE "createdAt" >= NOW() - INTERVAL '24 hours'
        GROUP BY date_trunc('hour', "createdAt")
        ORDER BY date_trunc('hour', "createdAt") ASC
      `),
      ]);

    const totalQueries24h = Number(queryCounts?.queriesToday ?? '0');
    const avgRequestsPerHour = Math.round((totalQueries24h / 24) * 10) / 10;
    const currentRequestsPerHour = Number(queryCounts?.queriesLastHour ?? '0');

    const systemSettings = await this.getSystemSettings();
    const queueOccupation =
      (await this.redis.get('queue:similarity:occupation')) ?? 'low';

    return {
      users: {
        total: Number(userCounts?.totalUsers ?? '0'),
        registered: Number(userCounts?.registeredUsers ?? '0'),
        anonymous: Number(userCounts?.anonymousUsers ?? '0'),
        newLast30Days: Number(userCounts?.newUsers30d ?? '0'),
      },
      similarityQueue: {
        occupation: queueOccupation,
        anonymousThroughputPerMinute:
          systemSettings.similarityQuota.anonymousThroughputPerMinute,
        registeredThroughputPerMinute:
          systemSettings.similarityQuota.registeredThroughputPerMinute,
      },
      storageQuota: {
        defaultStorageLimitMb:
          systemSettings.storageConfig.defaultStorageLimitMb,
        totalStorageBytes: Number(storageCounts?.totalStorageBytes ?? '0'),
        totalSources: Number(storageCounts?.totalSources ?? '0'),
      },
      requests: {
        totalQueries: Number(queryCounts?.totalQueries ?? '0'),
        queriesLast24Hours: totalQueries24h,
        currentRequestsPerHour,
        avgRequestsPerHour,
        hourlyDistribution: hourlyQueries.map((h) => ({
          hour: h.hour,
          count: Number(h.count),
        })),
      },
      graphs: {
        total: Number(graphCounts?.totalGraphs ?? '0'),
        public: Number(graphCounts?.publicGraphs ?? '0'),
        private: Number(graphCounts?.privateGraphs ?? '0'),
        active: Number(graphCounts?.activeGraphs ?? '0'),
        inactive: Number(graphCounts?.inactiveGraphs ?? '0'),
        scheduledForDeletion: Number(
          graphCounts?.scheduledDeletionGraphs ?? '0',
        ),
        retentionExempt: Number(graphCounts?.exemptGraphs ?? '0'),
      },
      storage: {
        totalSources: Number(storageCounts?.totalSources ?? '0'),
        totalStorageBytes: Number(storageCounts?.totalStorageBytes ?? '0'),
        archivesCount: Number(storageCounts?.archivesCount ?? '0'),
        archivesBytes: Number(storageCounts?.archivesBytes ?? '0'),
      },
    };
  }

  async getUsers(params: {
    page?: number;
    limit?: number;
    search?: string;
    tier?: string;
    storageFilter?: 'ALL' | 'HIGH_USAGE' | 'HAS_STORAGE';
    activityFilter?: 'ALL' | 'ACTIVE' | 'INACTIVE';
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (params.search) {
      conditions.push(
        `("email" ILIKE $${paramIdx} OR "name" ILIKE $${paramIdx} OR "username" ILIKE $${paramIdx})`,
      );
      values.push(`%${params.search.trim()}%`);
      paramIdx++;
    }

    if (params.tier && params.tier !== 'ALL') {
      if (params.tier === 'ANONYMOUS') {
        conditions.push('"isAnonymous" = true');
      } else {
        conditions.push(`"subscriptionTier" = $${paramIdx}`);
        values.push(params.tier);
        paramIdx++;
      }
    }

    if (params.storageFilter === 'HIGH_USAGE') {
      conditions.push(
        `(SELECT COALESCE(SUM(s."sizeBytes"), 0) FROM "NodeSource" s JOIN "Graph" g ON g."id" = s."graphId" WHERE g."userId" = u."id") >= (COALESCE(u."storageLimitMb", 100) * 1024 * 1024 * 0.8)`,
      );
    } else if (params.storageFilter === 'HAS_STORAGE') {
      conditions.push(
        `EXISTS (SELECT 1 FROM "NodeSource" s JOIN "Graph" g ON g."id" = s."graphId" WHERE g."userId" = u."id")`,
      );
    }

    if (params.activityFilter === 'ACTIVE') {
      conditions.push(
        `(EXISTS (SELECT 1 FROM "Graph" g WHERE g."userId" = u."id") OR EXISTS (SELECT 1 FROM "Query" q WHERE q."userId" = u."id"))`,
      );
    } else if (params.activityFilter === 'INACTIVE') {
      conditions.push(
        `(NOT EXISTS (SELECT 1 FROM "Graph" g WHERE g."userId" = u."id") AND NOT EXISTS (SELECT 1 FROM "Query" q WHERE q."userId" = u."id"))`,
      );
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const totalRow = await this.database.one<{ total: string }>(
      `SELECT COUNT(*)::text AS "total" FROM "User" u ${whereClause}`,
      values,
    );
    const total = Number(totalRow?.total ?? '0');

    const users = await this.database.query<AdminUserRow>(
      `SELECT
         u."id",
         u."name",
         u."email",
         u."username",
         u."isAnonymous",
         u."subscriptionTier",
         NULL::timestamp with time zone AS "subscriptionExpiresAt",
         u."storageLimitMb",
         u."preferredLanguage",
         u."createdAt",
         u."updatedAt",
         (SELECT COUNT(*)::int FROM "Graph" g WHERE g."userId" = u."id") AS "graphsCount",
         (SELECT COUNT(*)::int FROM "NodeSource" s JOIN "Graph" g ON g."id" = s."graphId" WHERE g."userId" = u."id") AS "sourcesCount",
         (SELECT COALESCE(SUM(s."sizeBytes"), 0)::bigint FROM "NodeSource" s JOIN "Graph" g ON g."id" = s."graphId" WHERE g."userId" = u."id") AS "usedStorageBytes"
       FROM "User" u
       ${whereClause}
       ORDER BY u."createdAt" DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...values, limit, offset],
    );

    return {
      users,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getUserDetails(id: string) {
    const user = await this.database.one<AdminUserDetailsRow>(
      `SELECT
         u."id",
         u."name",
         u."email",
         u."username",
         u."isAnonymous",
         u."subscriptionTier",
         NULL::timestamp with time zone AS "subscriptionExpiresAt",
         u."storageLimitMb",
         u."preferredLanguage",
         u."createdAt",
         u."updatedAt"
       FROM "User" u
       WHERE u."id" = $1`,
      [id],
    );
    if (!user) {
      throw new NotFoundException(`User ${id} not found.`);
    }

    const [graphs, recentQueries, storageUsage] = await Promise.all([
      this.database.query<AdminUserGraphRow>(
        `SELECT "id", "title", "isPublic", "isExemptFromRetention", "lastAccessedAt", "createdAt"
         FROM "Graph" WHERE "userId" = $1 ORDER BY "updatedAt" DESC`,
        [id],
      ),
      this.database.query<AdminUserRecentQueryRow>(
        `SELECT "id", "graphId", "queryText", "createdAt"
         FROM "Query" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 10`,
        [id],
      ),
      this.database.one<{ totalBytes: string; count: string }>(
        `SELECT
           COALESCE(SUM(s."sizeBytes"), 0)::text AS "totalBytes",
           COUNT(s.*)::text AS "count"
         FROM "NodeSource" s
         JOIN "Graph" g ON g."id" = s."graphId"
         WHERE g."userId" = $1`,
        [id],
      ),
    ]);

    return {
      user,
      graphs,
      recentQueries,
      storage: {
        sourcesCount: Number(storageUsage?.count ?? '0'),
        totalBytes: Number(storageUsage?.totalBytes ?? '0'),
      },
    };
  }

  async updateUser(
    id: string,
    data: {
      name?: string;
      username?: string;
      subscriptionTier?: string;
      subscriptionExpiresAt?: string | null;
      storageLimitMb?: number | null;
    },
    actor?: ViewerIdentity,
  ) {
    const user = await this.database.one(
      'SELECT "id" FROM "User" WHERE "id" = $1',
      [id],
    );
    if (!user) throw new NotFoundException(`User ${id} not found.`);

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      updates.push(`"name" = $${idx++}`);
      values.push(data.name.trim());
    }
    if (data.username !== undefined) {
      updates.push(`"username" = $${idx++}`);
      values.push(data.username.trim());
    }
    if (data.subscriptionTier !== undefined) {
      const tier = data.subscriptionTier.toUpperCase();
      if (!['REGISTERED', 'ANONYMOUS'].includes(tier)) {
        throw new BadRequestException(`Invalid subscription tier: ${tier}`);
      }
      updates.push(`"subscriptionTier" = $${idx++}`);
      values.push(tier);
    }
    if (data.storageLimitMb !== undefined) {
      if (data.storageLimitMb !== null && data.storageLimitMb < 0) {
        throw new BadRequestException('Storage limit cannot be negative.');
      }
      updates.push(`"storageLimitMb" = $${idx++}`);
      values.push(data.storageLimitMb);
    }

    if (updates.length === 0) return this.getUserDetails(id);

    updates.push('"updatedAt" = CURRENT_TIMESTAMP');
    values.push(id);

    await this.database.query(
      `UPDATE "User" SET ${updates.join(', ')} WHERE "id" = $${idx}`,
      values,
    );

    const details = await this.getUserDetails(id);
    await this.recordAuditEvent({
      actorId: actor?.userId ?? 'admin',
      actorEmail: actor?.email ?? undefined,
      action: 'user.update',
      targetType: 'user',
      targetId: id,
      details: data,
    });

    return details;
  }

  async updateUserStorageLimit(
    id: string,
    storageLimitMb: number | null,
    actor?: ViewerIdentity,
  ) {
    if (storageLimitMb !== null && storageLimitMb < 0) {
      throw new BadRequestException('Storage limit cannot be negative.');
    }
    const user = await this.database.one<{ id: string; email: string }>(
      'SELECT "id", "email" FROM "User" WHERE "id" = $1',
      [id],
    );
    if (!user) throw new NotFoundException(`User ${id} not found.`);

    await this.database.query(
      'UPDATE "User" SET "storageLimitMb" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2',
      [storageLimitMb, id],
    );

    await this.recordAuditEvent({
      actorId: actor?.userId ?? 'admin',
      actorEmail: actor?.email ?? undefined,
      action: 'user.storage_limit_update',
      targetType: 'user',
      targetId: id,
      details: { storageLimitMb },
    });

    return { id, storageLimitMb };
  }

  async deleteUser(id: string, actor?: ViewerIdentity) {
    const user = await this.database.one<{ id: string; email: string }>(
      'SELECT "id", "email" FROM "User" WHERE "id" = $1',
      [id],
    );
    if (!user) throw new NotFoundException(`User ${id} not found.`);

    const graphs = await this.database.query<{ id: string }>(
      'SELECT "id" FROM "Graph" WHERE "userId" = $1',
      [id],
    );
    for (const g of graphs) {
      await this.deleteGraph(g.id, actor);
    }

    await this.database.query('DELETE FROM "User" WHERE "id" = $1', [id]);

    await this.recordAuditEvent({
      actorId: actor?.userId ?? 'admin',
      actorEmail: actor?.email ?? undefined,
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
      details: { email: user.email },
    });

    return { deleted: true, userId: id };
  }

  async getGraphs(params: {
    page?: number;
    limit?: number;
    search?: string;
    visibility?: string;
    retention?: string;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (params.search) {
      conditions.push(
        `(g."title" ILIKE $${idx} OR u."email" ILIKE $${idx} OR u."name" ILIKE $${idx})`,
      );
      values.push(`%${params.search.trim()}%`);
      idx++;
    }

    if (params.visibility && params.visibility !== 'ALL') {
      conditions.push(`g."isPublic" = $${idx}`);
      values.push(params.visibility === 'PUBLIC');
      idx++;
    }

    if (params.retention && params.retention !== 'ALL') {
      if (params.retention === 'EXEMPT') {
        conditions.push('g."isExemptFromRetention" = true');
      } else if (params.retention === 'SCHEDULED') {
        conditions.push('g."scheduledForDeletionAt" IS NOT NULL');
      } else if (params.retention === 'INACTIVE') {
        conditions.push('g."lastAccessedAt" < NOW() - INTERVAL \'90 days\'');
      }
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const totalRow = await this.database.one<{ total: string }>(
      `SELECT COUNT(*)::text AS "total"
       FROM "Graph" g
       LEFT JOIN "User" u ON u."id" = g."userId"
       ${whereClause}`,
      values,
    );
    const total = Number(totalRow?.total ?? '0');

    const graphs = await this.database.query<AdminGraphInspectionRow>(
      `SELECT
         g."id",
         g."title",
         g."description",
         g."userId",
         g."isPublic",
         g."isPrepared",
         g."lastAccessedAt",
         g."scheduledForDeletionAt",
         g."isExemptFromRetention",
         g."createdAt",
         g."updatedAt",
         u."email" AS "ownerEmail",
         u."name" AS "ownerName",
         jsonb_array_length(g."nodes") AS "nodeCount",
         (SELECT COUNT(*)::int FROM "NodeSource" s WHERE s."graphId" = g."id") AS "sourceCount"
       FROM "Graph" g
       LEFT JOIN "User" u ON u."id" = g."userId"
       ${whereClause}
       ORDER BY g."updatedAt" DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset],
    );

    return {
      graphs,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getGraphDetails(id: string) {
    const graph = await this.database.one<AdminGraphDetailsRow>(
      `SELECT
         g."id",
         g."title",
         g."description",
         g."userId",
         g."isPublic",
         g."isPrepared",
         g."nodes",
         g."edges",
         g."lastAccessedAt",
         g."scheduledForDeletionAt",
         g."isExemptFromRetention",
         g."createdAt",
         g."updatedAt",
         u."email" AS "ownerEmail",
         u."name" AS "ownerName"
       FROM "Graph" g
       LEFT JOIN "User" u ON u."id" = g."userId"
       WHERE g."id" = $1`,
      [id],
    );
    if (!graph) throw new NotFoundException(`Graph ${id} not found.`);

    const sources = await this.database.query<AdminSourceInspectionRow>(
      `SELECT "id", "nodeId", "name", "fileType", "fileUrl", "sizeBytes", "status", "createdAt"
       FROM "NodeSource" WHERE "graphId" = $1`,
      [id],
    );

    return { ...graph, sources };
  }

  async updateGraph(
    id: string,
    data: {
      title?: string;
      description?: string | null;
      isPublic?: boolean;
      isExemptFromRetention?: boolean;
      resetRetention?: boolean;
    },
    actor?: ViewerIdentity,
  ) {
    const graph = await this.database.one(
      'SELECT "id" FROM "Graph" WHERE "id" = $1',
      [id],
    );
    if (!graph) throw new NotFoundException(`Graph ${id} not found.`);

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.title !== undefined) {
      updates.push(`"title" = $${idx++}`);
      values.push(data.title.trim());
    }
    if (data.description !== undefined) {
      updates.push(`"description" = $${idx++}`);
      values.push(data.description ? data.description.trim() : null);
    }
    if (data.isPublic !== undefined) {
      updates.push(`"isPublic" = $${idx++}`);
      values.push(data.isPublic);
    }
    if (data.isExemptFromRetention !== undefined) {
      updates.push(`"isExemptFromRetention" = $${idx++}`);
      values.push(data.isExemptFromRetention);
    }
    if (data.resetRetention) {
      updates.push('"scheduledForDeletionAt" = NULL');
      updates.push('"lastAccessedAt" = CURRENT_TIMESTAMP');
    }

    if (updates.length === 0) return this.getGraphDetails(id);

    updates.push('"updatedAt" = CURRENT_TIMESTAMP');
    values.push(id);

    await this.database.query(
      `UPDATE "Graph" SET ${updates.join(', ')} WHERE "id" = $${idx}`,
      values,
    );

    const details = await this.getGraphDetails(id);
    await this.recordAuditEvent({
      actorId: actor?.userId ?? 'admin',
      actorEmail: actor?.email ?? undefined,
      action: 'graph.update',
      targetType: 'graph',
      targetId: id,
      details: data,
    });

    return details;
  }

  async updateGraphContent(
    id: string,
    data: { nodes: any[]; edges: any[] },
    actor?: ViewerIdentity,
  ) {
    const graph = await this.database.one(
      'SELECT "id" FROM "Graph" WHERE "id" = $1',
      [id],
    );
    if (!graph) throw new NotFoundException(`Graph ${id} not found.`);

    await this.database.query(
      `UPDATE "Graph"
       SET "nodes" = $1::jsonb, "edges" = $2::jsonb, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $3`,
      [JSON.stringify(data.nodes), JSON.stringify(data.edges), id],
    );

    const details = await this.getGraphDetails(id);
    await this.recordAuditEvent({
      actorId: actor?.userId ?? 'admin',
      actorEmail: actor?.email ?? undefined,
      action: 'graph.update_content',
      targetType: 'graph',
      targetId: id,
      details: { nodeCount: data.nodes.length, edgeCount: data.edges.length },
    });

    return details;
  }

  async deleteGraph(id: string, actor?: ViewerIdentity) {
    const graph = await this.database.one<{ id: string; title: string }>(
      'SELECT "id", "title" FROM "Graph" WHERE "id" = $1',
      [id],
    );
    if (!graph) throw new NotFoundException(`Graph ${id} not found.`);

    const sources = await this.database.query<{ fileUrl: string }>(
      'SELECT "fileUrl" FROM "NodeSource" WHERE "graphId" = $1',
      [id],
    );
    for (const s of sources) {
      try {
        await this.storage.deleteObject(s.fileUrl);
      } catch {
        // ignore
      }
    }

    try {
      await this.weaviate.deleteTenant(id);
    } catch {
      // ignore
    }

    try {
      const archive = await this.database.one<{ archiveUrl: string }>(
        'SELECT "archiveUrl" FROM "GraphArchive" WHERE "graphId" = $1',
        [id],
      );
      if (archive) {
        await this.storage.deleteObject(archive.archiveUrl);
        await this.database.query(
          'DELETE FROM "GraphArchive" WHERE "graphId" = $1',
          [id],
        );
      }
    } catch {
      // ignore
    }

    await this.database.query('DELETE FROM "Graph" WHERE "id" = $1', [id]);

    await this.recordAuditEvent({
      actorId: actor?.userId ?? 'admin',
      actorEmail: actor?.email ?? undefined,
      action: 'graph.delete',
      targetType: 'graph',
      targetId: id,
      details: { title: graph.title },
    });

    return { deleted: true, graphId: id };
  }

  async deleteArchive(graphId: string) {
    const archive = await this.database.one<{ archiveUrl: string }>(
      'SELECT "archiveUrl" FROM "GraphArchive" WHERE "graphId" = $1',
      [graphId],
    );
    if (!archive) {
      throw new NotFoundException(`Archive for graph ${graphId} not found.`);
    }

    try {
      await this.storage.deleteObject(archive.archiveUrl);
    } catch {
      // ignore
    }

    await this.database.query(
      'DELETE FROM "GraphArchive" WHERE "graphId" = $1',
      [graphId],
    );
    return { deleted: true, graphId };
  }

  // 7. Audit Log Export (CSV / JSON)
  async exportUsers(params: {
    format: 'csv' | 'json';
    search?: string;
    tier?: string;
    storageFilter?: 'ALL' | 'HIGH_USAGE' | 'HAS_STORAGE';
    activityFilter?: 'ALL' | 'ACTIVE' | 'INACTIVE';
  }) {
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (params.search) {
      conditions.push(
        `("email" ILIKE $${paramIdx} OR "name" ILIKE $${paramIdx} OR "username" ILIKE $${paramIdx})`,
      );
      values.push(`%${params.search.trim()}%`);
      paramIdx++;
    }

    if (params.tier && params.tier !== 'ALL') {
      if (params.tier === 'ANONYMOUS') {
        conditions.push('"isAnonymous" = true');
      } else {
        conditions.push(`"subscriptionTier" = $${paramIdx}`);
        values.push(params.tier);
        paramIdx++;
      }
    }

    if (params.storageFilter === 'HIGH_USAGE') {
      conditions.push(
        `(SELECT COALESCE(SUM(s."sizeBytes"), 0) FROM "NodeSource" s JOIN "Graph" g ON g."id" = s."graphId" WHERE g."userId" = u."id") >= (COALESCE(u."storageLimitMb", 100) * 1024 * 1024 * 0.8)`,
      );
    } else if (params.storageFilter === 'HAS_STORAGE') {
      conditions.push(
        `EXISTS (SELECT 1 FROM "NodeSource" s JOIN "Graph" g ON g."id" = s."graphId" WHERE g."userId" = u."id")`,
      );
    }

    if (params.activityFilter === 'ACTIVE') {
      conditions.push(
        `(EXISTS (SELECT 1 FROM "Graph" g WHERE g."userId" = u."id") OR EXISTS (SELECT 1 FROM "Query" q WHERE q."userId" = u."id"))`,
      );
    } else if (params.activityFilter === 'INACTIVE') {
      conditions.push(
        `(NOT EXISTS (SELECT 1 FROM "Graph" g WHERE g."userId" = u."id") AND NOT EXISTS (SELECT 1 FROM "Query" q WHERE q."userId" = u."id"))`,
      );
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const users = await this.database.query<AdminUserExportRow>(
      `SELECT
         u."id",
         u."name",
         u."email",
         u."username",
         u."isAnonymous",
         u."subscriptionTier",
         NULL::timestamp with time zone AS "subscriptionExpiresAt",
         u."storageLimitMb",
         u."createdAt",
         (SELECT COUNT(*)::int FROM "Graph" g WHERE g."userId" = u."id") AS "graphsCount",
         (SELECT COUNT(*)::int FROM "NodeSource" s JOIN "Graph" g ON g."id" = s."graphId" WHERE g."userId" = u."id") AS "sourcesCount",
         (SELECT COALESCE(SUM(s."sizeBytes"), 0)::bigint FROM "NodeSource" s JOIN "Graph" g ON g."id" = s."graphId" WHERE g."userId" = u."id") AS "usedStorageBytes"
       FROM "User" u
       ${whereClause}
       ORDER BY u."createdAt" DESC
       LIMIT 10000`,
      values,
    );

    if (params.format === 'csv') {
      const columns = [
        { key: 'id', label: 'User ID' },
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'username', label: 'Username' },
        { key: 'isAnonymous', label: 'Anonymous' },
        { key: 'subscriptionTier', label: 'Subscription Tier' },
        { key: 'subscriptionExpiresAt', label: 'Subscription Expires At' },
        { key: 'storageLimitMb', label: 'Storage Limit (MB)' },
        { key: 'usedStorageBytes', label: 'Used Storage (Bytes)' },
        { key: 'graphsCount', label: 'Graphs Count' },
        { key: 'sourcesCount', label: 'Sources Count' },
        { key: 'createdAt', label: 'Created At' },
      ];
      return toCsv(users, columns);
    }

    return users;
  }

  async batchUsers(
    dto: {
      userIds: string[];
      action: 'set_tier' | 'delete';
      tier?: string;
      durationDays?: number;
    },
    actor?: ViewerIdentity,
  ) {
    if (
      !dto.userIds ||
      !Array.isArray(dto.userIds) ||
      dto.userIds.length === 0
    ) {
      throw new BadRequestException(
        'userIds must be a non-empty array of user IDs.',
      );
    }

    if (dto.action === 'set_tier') {
      const tier = (dto.tier ?? 'REGISTERED').toUpperCase();
      if (!['REGISTERED', 'ANONYMOUS'].includes(tier)) {
        throw new BadRequestException(`Invalid subscription tier: ${tier}`);
      }

      await this.database.query(
        `UPDATE "User"
         SET "subscriptionTier" = $1, "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = ANY($2)`,
        [tier, dto.userIds],
      );

      await this.recordAuditEvent({
        actorId: actor?.userId ?? 'admin',
        actorEmail: actor?.email ?? undefined,
        action: 'user.batch_set_tier',
        targetType: 'user',
        details: {
          count: dto.userIds.length,
          tier,
        },
      });

      return {
        success: true,
        action: 'set_tier',
        count: dto.userIds.length,
        tier,
      };
    }

    if (dto.action === 'delete') {
      let deletedCount = 0;
      for (const uid of dto.userIds) {
        try {
          await this.deleteUser(uid, actor);
          deletedCount++;
        } catch {
          // continue with next user
        }
      }

      await this.recordAuditEvent({
        actorId: actor?.userId ?? 'admin',
        actorEmail: actor?.email ?? undefined,
        action: 'user.batch_delete',
        targetType: 'user',
        details: { count: deletedCount },
      });

      return {
        success: true,
        action: 'delete',
        count: deletedCount,
      };
    }

    throw new BadRequestException(`Unsupported batch action: ${dto.action}`);
  }

  async batchGraphs(
    dto: {
      graphIds: string[];
      action: 'set_retention_exempt' | 'set_visibility' | 'delete';
      exempt?: boolean;
      isPublic?: boolean;
    },
    actor?: ViewerIdentity,
  ) {
    if (
      !dto.graphIds ||
      !Array.isArray(dto.graphIds) ||
      dto.graphIds.length === 0
    ) {
      throw new BadRequestException(
        'graphIds must be a non-empty array of graph IDs.',
      );
    }

    if (dto.action === 'set_retention_exempt') {
      const exempt = Boolean(dto.exempt);
      await this.database.query(
        `UPDATE "Graph"
         SET "isExemptFromRetention" = $1,
             "scheduledForDeletionAt" = CASE WHEN $1 = true THEN NULL ELSE "scheduledForDeletionAt" END,
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = ANY($2)`,
        [exempt, dto.graphIds],
      );

      await this.recordAuditEvent({
        actorId: actor?.userId ?? 'admin',
        actorEmail: actor?.email ?? undefined,
        action: 'graph.batch_set_retention_exempt',
        targetType: 'graph',
        details: { count: dto.graphIds.length, exempt },
      });

      return {
        success: true,
        action: 'set_retention_exempt',
        count: dto.graphIds.length,
        exempt,
      };
    }

    if (dto.action === 'set_visibility') {
      const isPublic = Boolean(dto.isPublic);
      await this.database.query(
        `UPDATE "Graph"
         SET "isPublic" = $1,
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = ANY($2)`,
        [isPublic, dto.graphIds],
      );

      await this.recordAuditEvent({
        actorId: actor?.userId ?? 'admin',
        actorEmail: actor?.email ?? undefined,
        action: 'graph.batch_set_visibility',
        targetType: 'graph',
        details: { count: dto.graphIds.length, isPublic },
      });

      return {
        success: true,
        action: 'set_visibility',
        count: dto.graphIds.length,
        isPublic,
      };
    }

    if (dto.action === 'delete') {
      let deletedCount = 0;
      for (const gid of dto.graphIds) {
        try {
          await this.deleteGraph(gid, actor);
          deletedCount++;
        } catch {
          // continue
        }
      }

      await this.recordAuditEvent({
        actorId: actor?.userId ?? 'admin',
        actorEmail: actor?.email ?? undefined,
        action: 'graph.batch_delete',
        targetType: 'graph',
        details: { count: deletedCount },
      });

      return {
        success: true,
        action: 'delete',
        count: deletedCount,
      };
    }

    throw new BadRequestException(`Unsupported batch action: ${dto.action}`);
  }

  async getSystemSettings(): Promise<SystemSettings> {
    const raw = await this.redis.get('system:settings');
    let base = DEFAULT_SYSTEM_SETTINGS;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<SystemSettings>;
        base = {
          ...DEFAULT_SYSTEM_SETTINGS,
          ...parsed,
          similarityQuota: {
            ...DEFAULT_SYSTEM_SETTINGS.similarityQuota,
            ...(parsed.similarityQuota ?? {}),
          },
          storageConfig: {
            ...DEFAULT_SYSTEM_SETTINGS.storageConfig,
            ...(parsed.storageConfig ?? {}),
          },
          adConfig: {
            ...DEFAULT_SYSTEM_SETTINGS.adConfig,
            ...(parsed.adConfig ?? {}),
          },
          rateLimits: {
            ...DEFAULT_SYSTEM_SETTINGS.rateLimits,
            ...(parsed.rateLimits ?? {}),
          },
          maintenanceExemptions: {
            ...DEFAULT_SYSTEM_SETTINGS.maintenanceExemptions,
            ...(parsed.maintenanceExemptions ?? {}),
          },
          synonymsConfig: {
            ...DEFAULT_SYSTEM_SETTINGS.synonymsConfig,
            ...(parsed.synonymsConfig ?? {}),
          },
        };
      } catch {
        base = DEFAULT_SYSTEM_SETTINGS;
      }
    }
    try {
      const rows = await this.database.query<{ key: string; value: any }>(
        `SELECT "key", "value" FROM "SystemSettings" WHERE "key" IN ('similarityQuota', 'storageConfig', 'adConfig', 'synonymsConfig')`,
      );
      for (const row of rows) {
        if (row.key === 'similarityQuota' && row.value) {
          base.similarityQuota = {
            ...base.similarityQuota,
            ...row.value,
          };
        }
        if (row.key === 'storageConfig' && row.value) {
          base.storageConfig = {
            ...base.storageConfig,
            ...row.value,
          };
        }
        if (row.key === 'adConfig' && row.value) {
          base.adConfig = {
            ...base.adConfig,
            ...row.value,
          };
        }
        if (row.key === 'synonymsConfig' && row.value) {
          base.synonymsConfig = {
            ...base.synonymsConfig,
            ...row.value,
          };
        }
      }
    } catch {
      // Table may not be ready during initial boot
    }
    return base;
  }

  async updateSystemSettings(
    patch: Partial<SystemSettings>,
    actor?: ViewerIdentity,
  ): Promise<SystemSettings> {
    if (patch.retentionDays !== undefined && patch.retentionDays < 1) {
      throw new BadRequestException('retentionDays must be at least 1.');
    }
    if (
      patch.retentionGraceDays !== undefined &&
      patch.retentionGraceDays < 0
    ) {
      throw new BadRequestException('retentionGraceDays cannot be negative.');
    }
    if (patch.similarityQuota) {
      if (
        patch.similarityQuota.anonymousThroughputPerMinute !== undefined &&
        patch.similarityQuota.anonymousThroughputPerMinute < 1
      ) {
        throw new BadRequestException(
          'anonymousThroughputPerMinute must be at least 1.',
        );
      }
      if (
        patch.similarityQuota.registeredThroughputPerMinute !== undefined &&
        patch.similarityQuota.registeredThroughputPerMinute < 1
      ) {
        throw new BadRequestException(
          'registeredThroughputPerMinute must be at least 1.',
        );
      }
    }
    if (patch.storageConfig) {
      if (
        patch.storageConfig.defaultStorageLimitMb !== undefined &&
        patch.storageConfig.defaultStorageLimitMb < 1
      ) {
        throw new BadRequestException(
          'defaultStorageLimitMb must be at least 1 MB.',
        );
      }
    }
    if (patch.rateLimits) {
      if (
        patch.rateLimits.anonymousPerMinute !== undefined &&
        patch.rateLimits.anonymousPerMinute < 1
      ) {
        throw new BadRequestException(
          'anonymousPerMinute rate limit must be at least 1.',
        );
      }
      if (
        patch.rateLimits.authenticatedPerMinute !== undefined &&
        patch.rateLimits.authenticatedPerMinute < 1
      ) {
        throw new BadRequestException(
          'authenticatedPerMinute rate limit must be at least 1.',
        );
      }
      if (
        patch.rateLimits.burstMultiplier !== undefined &&
        patch.rateLimits.burstMultiplier < 1
      ) {
        throw new BadRequestException('burstMultiplier must be at least 1.');
      }
    }
    if (patch.adConfig) {
      if (
        patch.adConfig.effectiveEcpm !== undefined &&
        (patch.adConfig.effectiveEcpm <= 0 ||
          Number.isNaN(patch.adConfig.effectiveEcpm))
      ) {
        throw new BadRequestException('effectiveEcpm must be greater than 0.');
      }
      if (
        patch.adConfig.canvasAdDensity !== undefined &&
        patch.adConfig.canvasAdDensity < 1
      ) {
        throw new BadRequestException('canvasAdDensity must be at least 1.');
      }
      if (
        patch.adConfig.maxCanvasAds !== undefined &&
        patch.adConfig.maxCanvasAds < 1
      ) {
        throw new BadRequestException('maxCanvasAds must be at least 1.');
      }
    }

    if (patch.synonymsConfig !== undefined) {
      if (
        typeof patch.synonymsConfig !== 'object' ||
        patch.synonymsConfig === null
      ) {
        throw new BadRequestException('synonymsConfig must be an object.');
      }
      for (const [key, val] of Object.entries(patch.synonymsConfig)) {
        if (!key.trim()) {
          throw new BadRequestException('Synonym key cannot be empty.');
        }
        if (
          !Array.isArray(val) ||
          !val.every((item) => typeof item === 'string')
        ) {
          throw new BadRequestException(
            `Synonym for "${key}" must be an array of strings.`,
          );
        }
      }
    }

    const current = await this.getSystemSettings();
    const updated: SystemSettings = {
      ...current,
      ...patch,
      similarityQuota: {
        ...current.similarityQuota,
        ...(patch.similarityQuota ?? {}),
      },
      storageConfig: {
        ...current.storageConfig,
        ...(patch.storageConfig ?? {}),
      },
      adConfig: {
        ...current.adConfig,
        ...(patch.adConfig ?? {}),
      },
      rateLimits: {
        ...current.rateLimits,
        ...(patch.rateLimits ?? {}),
      },
      maintenanceExemptions: {
        ...current.maintenanceExemptions,
        ...(patch.maintenanceExemptions ?? {}),
      },
      synonymsConfig:
        patch.synonymsConfig !== undefined
          ? patch.synonymsConfig
          : current.synonymsConfig,
      updatedAt: new Date().toISOString(),
    };

    if (patch.similarityQuota) {
      await this.database.query(
        `INSERT INTO "SystemSettings" ("key", "value", "updatedAt")
         VALUES ('similarityQuota', $1::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT ("key") DO UPDATE SET "value" = $1::jsonb, "updatedAt" = CURRENT_TIMESTAMP`,
        [JSON.stringify(updated.similarityQuota)],
      );
      this.similarityQueue?.updateConfig(updated.similarityQuota);
    }

    if (patch.storageConfig) {
      await this.database.query(
        `INSERT INTO "SystemSettings" ("key", "value", "updatedAt")
         VALUES ('storageConfig', $1::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT ("key") DO UPDATE SET "value" = $1::jsonb, "updatedAt" = CURRENT_TIMESTAMP`,
        [JSON.stringify(updated.storageConfig)],
      );
    }

    if (patch.adConfig) {
      await this.database.query(
        `INSERT INTO "SystemSettings" ("key", "value", "updatedAt")
         VALUES ('adConfig', $1::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT ("key") DO UPDATE SET "value" = $1::jsonb, "updatedAt" = CURRENT_TIMESTAMP`,
        [JSON.stringify(updated.adConfig)],
      );
    }

    if (patch.synonymsConfig !== undefined) {
      await this.database.query(
        `INSERT INTO "SystemSettings" ("key", "value", "updatedAt")
         VALUES ('synonymsConfig', $1::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT ("key") DO UPDATE SET "value" = $1::jsonb, "updatedAt" = CURRENT_TIMESTAMP`,
        [JSON.stringify(updated.synonymsConfig)],
      );
    }

    await this.redis.set('system:settings', JSON.stringify(updated));
    await this.redis.publish(
      'system:settings:updated',
      JSON.stringify({
        type: 'system:settings:updated',
        settings: updated,
      }),
    );

    await this.recordAuditEvent({
      actorId: actor?.userId,
      actorEmail: actor?.email ?? undefined,
      action:
        patch.maintenanceMode !== undefined
          ? patch.maintenanceMode
            ? 'system.maintenance_enable'
            : 'system.maintenance_disable'
          : 'system.settings_update',
      targetType: 'system',
      targetId: 'settings',
      details: {
        patch,
        maintenanceMode: updated.maintenanceMode,
      },
    });

    return updated;
  }

  // 9. Real-Time Admin Audit Log Stream
  async recordAuditEvent(event: {
    actorId?: string;
    actorEmail?: string;
    action: string;
    targetType: 'system' | 'user' | 'graph' | 'subscription' | 'retention';
    targetId?: string;
    details?: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
  }): Promise<AdminAuditEvent> {
    const fullEvent: AdminAuditEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      actorId: event.actorId ?? 'system',
      actorEmail: event.actorEmail,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      details: event.details ?? {},
      ip: event.ip,
      userAgent: event.userAgent,
    };

    const serialized = JSON.stringify(fullEvent);
    await this.redis.lpush('admin:audit_log', serialized);
    await this.redis.ltrim('admin:audit_log', 0, 999);
    await this.redis.publish('admin:audit_events', serialized);

    return fullEvent;
  }

  async getAuditLogs(query?: GetAuditLogsQueryDto): Promise<{
    items: AdminAuditEvent[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(Math.max(Number(query?.limit ?? 50), 1), 200);
    const offset = Math.max(Number(query?.offset ?? 0), 0);

    const rawItems = await this.redis.lrange('admin:audit_log', 0, 999);
    let allEvents: AdminAuditEvent[] = [];

    for (const raw of rawItems) {
      try {
        allEvents.push(JSON.parse(raw));
      } catch {
        // Ignore unparseable entries
      }
    }

    if (query?.action) {
      allEvents = allEvents.filter((e) => e.action === query.action);
    }
    if (query?.targetType) {
      allEvents = allEvents.filter((e) => e.targetType === query.targetType);
    }

    const total = allEvents.length;
    const items = allEvents.slice(offset, offset + limit);

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  async archiveAuditLogs(
    dto?: ArchiveAuditLogsDto,
    identity?: ViewerIdentity,
  ): Promise<AuditLogArchive> {
    const rawItems = await this.redis.lrange('admin:audit_log', 0, -1);
    const allEvents: AdminAuditEvent[] = [];
    for (const raw of rawItems) {
      try {
        allEvents.push(JSON.parse(raw));
      } catch {
        // Skip corrupted
      }
    }

    if (allEvents.length === 0) {
      return {
        id: '',
        key: '',
        filename: '',
        eventCount: 0,
        sizeBytes: 0,
        createdAt: new Date().toISOString(),
      };
    }

    let toArchive: AdminAuditEvent[] = [];
    let toKeep: AdminAuditEvent[] = [];

    if (dto?.olderThanDays !== undefined && dto.olderThanDays > 0) {
      const cutoff = Date.now() - dto.olderThanDays * 86400000;
      for (const ev of allEvents) {
        const evTime = new Date(ev.timestamp).getTime();
        if (evTime < cutoff) {
          toArchive.push(ev);
        } else {
          toKeep.push(ev);
        }
      }
    } else if (dto?.retainCount !== undefined && dto.retainCount >= 0) {
      toKeep = allEvents.slice(0, dto.retainCount);
      toArchive = allEvents.slice(dto.retainCount);
    } else {
      toArchive = [...allEvents];
      toKeep = [];
    }

    if (toArchive.length === 0) {
      return {
        id: '',
        key: '',
        filename: '',
        eventCount: 0,
        sizeBytes: 0,
        createdAt: new Date().toISOString(),
      };
    }

    const archiveId = crypto.randomUUID();
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dateStr = now.toISOString().replace(/[:.]/g, '-');
    const filename = `audit-log-${dateStr}-${archiveId.slice(0, 8)}.json.gz`;
    const key = `audit-logs/${year}/${month}/${filename}`;

    const jsonLines = toArchive.map((e) => JSON.stringify(e)).join('\n');
    const gzipBuffer = gzipSync(Buffer.from(jsonLines, 'utf8'));

    await this.storage.putObject(
      key,
      gzipBuffer,
      'application/gzip',
      'GLACIER',
    );

    // Repopulate Redis active log with remaining events
    await this.redis.del('admin:audit_log');
    if (toKeep.length > 0) {
      for (let i = toKeep.length - 1; i >= 0; i--) {
        await this.redis.lpush('admin:audit_log', JSON.stringify(toKeep[i]));
      }
    }

    const timestamps = toArchive
      .map((e) => e.timestamp)
      .filter(Boolean)
      .sort();
    const firstEventTimestamp = timestamps[0];
    const lastEventTimestamp = timestamps[timestamps.length - 1];

    const archiveRecord: AuditLogArchive = {
      id: archiveId,
      key,
      filename,
      eventCount: toArchive.length,
      sizeBytes: gzipBuffer.length,
      firstEventTimestamp,
      lastEventTimestamp,
      createdAt: now.toISOString(),
    };

    await this.redis.lpush(
      'admin:audit_archives',
      JSON.stringify(archiveRecord),
    );

    await this.recordAuditEvent({
      actorId: identity?.userId ?? 'system',
      actorEmail: identity?.email ?? undefined,
      action: 'audit_log.archive',
      targetType: 'system',
      targetId: archiveId,
      details: {
        archiveId,
        key,
        filename,
        eventCount: toArchive.length,
        sizeBytes: gzipBuffer.length,
      },
    });

    return archiveRecord;
  }

  async getAuditArchives(query?: { limit?: number; offset?: number }): Promise<{
    items: AuditLogArchive[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(Math.max(Number(query?.limit ?? 50), 1), 100);
    const offset = Math.max(Number(query?.offset ?? 0), 0);

    const rawItems = await this.redis.lrange('admin:audit_archives', 0, -1);
    const allArchives: AuditLogArchive[] = [];
    for (const raw of rawItems) {
      try {
        allArchives.push(JSON.parse(raw));
      } catch {
        // Skip corrupted
      }
    }

    const total = allArchives.length;
    const items = allArchives.slice(offset, offset + limit);

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  async getAuditArchiveById(
    archiveId: string,
  ): Promise<AuditLogArchive | null> {
    const rawItems = await this.redis.lrange('admin:audit_archives', 0, -1);
    for (const raw of rawItems) {
      try {
        const item: AuditLogArchive = JSON.parse(raw);
        if (item.id === archiveId || item.key === archiveId) {
          return item;
        }
      } catch {
        // Skip corrupted
      }
    }
    return null;
  }

  async downloadAuditArchive(archiveId: string): Promise<{
    buffer: Buffer;
    filename: string;
    contentType: string;
    contentLength: number;
  }> {
    const archive = await this.getAuditArchiveById(archiveId);
    if (!archive) {
      throw new NotFoundException(`Audit log archive ${archiveId} not found`);
    }

    const file = await this.storage.getObject(archive.key);
    return {
      buffer: file.buffer,
      filename: archive.filename,
      contentType: file.contentType || 'application/gzip',
      contentLength: file.contentLength,
    };
  }

  async getAuditArchiveContent(
    archiveId: string,
    query?: { search?: string; limit?: number; offset?: number },
  ): Promise<AuditArchivePreviewResponse> {
    const archive = await this.getAuditArchiveById(archiveId);
    if (!archive) {
      throw new NotFoundException(`Audit log archive ${archiveId} not found`);
    }

    const file = await this.storage.getObject(archive.key);
    let decompressed: string;
    try {
      decompressed = gunzipSync(file.buffer).toString('utf8');
    } catch {
      throw new BadRequestException('Failed to decompress audit log archive');
    }

    const rawLines = decompressed
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    let events: AdminAuditEvent[] = [];
    for (const line of rawLines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip malformed entries
      }
    }

    if (query?.search && query.search.trim()) {
      const q = query.search.trim().toLowerCase();
      events = events.filter((ev) => {
        const actionMatch = ev.action?.toLowerCase().includes(q);
        const actorIdMatch = ev.actorId?.toLowerCase().includes(q);
        const actorEmailMatch = ev.actorEmail?.toLowerCase().includes(q);
        const targetTypeMatch = ev.targetType?.toLowerCase().includes(q);
        const targetIdMatch = ev.targetId?.toLowerCase().includes(q);
        const detailsMatch = ev.details
          ? JSON.stringify(ev.details).toLowerCase().includes(q)
          : false;
        return (
          actionMatch ||
          actorIdMatch ||
          actorEmailMatch ||
          targetTypeMatch ||
          targetIdMatch ||
          detailsMatch
        );
      });
    }

    const total = events.length;
    const limit = Math.min(Math.max(Number(query?.limit ?? 50), 1), 500);
    const offset = Math.max(Number(query?.offset ?? 0), 0);
    const items = events.slice(offset, offset + limit);

    return {
      archive,
      items,
      total,
      limit,
      offset,
    };
  }
}

export type MaintenanceExemptions = {
  allowedIps?: string[];
  exemptUserIds?: string[];
  exemptRoles?: string[];
};

export type SimilarityQuotaConfig = {
  anonymousThroughputPerMinute: number;
  registeredThroughputPerMinute: number;
};

export type StorageConfig = {
  defaultStorageLimitMb: number;
};

export type AdConfig = {
  effectiveEcpm: number;
  canvasAdDensity: number;
  maxCanvasAds: number;
};

export type SystemSettings = {
  retentionDays: number;
  retentionGraceDays: number;
  similarityQuota: SimilarityQuotaConfig;
  storageConfig: StorageConfig;
  adConfig: AdConfig;
  rateLimits: {
    anonymousPerMinute: number;
    authenticatedPerMinute: number;
    burstMultiplier: number;
  };
  maintenanceMode: boolean;
  maintenanceExemptions?: MaintenanceExemptions;
  synonymsConfig?: Record<string, string[]>;
  updatedAt: string;
};

export type AdminAuditEvent = {
  id: string;
  timestamp: string;
  actorId: string;
  actorEmail?: string;
  action: string;
  targetType: 'system' | 'user' | 'graph' | 'subscription' | 'retention';
  targetId?: string;
  details: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
};

export type GetAuditLogsQueryDto = {
  limit?: number;
  offset?: number;
  action?: string;
  targetType?: string;
};

export type AuditLogArchive = {
  id: string;
  key: string;
  filename: string;
  eventCount: number;
  sizeBytes: number;
  firstEventTimestamp?: string;
  lastEventTimestamp?: string;
  createdAt: string;
};

export type AuditArchivePreviewResponse = {
  archive: AuditLogArchive;
  items: AdminAuditEvent[];
  total: number;
  limit: number;
  offset: number;
};

export type ArchiveAuditLogsDto = {
  olderThanDays?: number;
  retainCount?: number;
};

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  retentionDays: 90,
  retentionGraceDays: 7,
  similarityQuota: {
    anonymousThroughputPerMinute: 30,
    registeredThroughputPerMinute: 120,
  },
  storageConfig: {
    defaultStorageLimitMb: 100,
  },
  adConfig: {
    effectiveEcpm: 1.5,
    canvasAdDensity: 35,
    maxCanvasAds: 5,
  },
  rateLimits: {
    anonymousPerMinute: 30,
    authenticatedPerMinute: 120,
    burstMultiplier: 2,
  },
  maintenanceMode: false,
  maintenanceExemptions: {
    allowedIps: ['127.0.0.1', '::1'],
    exemptUserIds: [],
    exemptRoles: ['admin'],
  },
  synonymsConfig: {
    k8s: ['kubernetes'],
    kubernetes: ['k8s'],
    db: ['database'],
    database: ['db'],
    bfs: ['breadth-first search'],
    dfs: ['depth-first search'],
    mst: ['minimum spanning tree'],
    api: ['application programming interface'],
    ai: ['artificial intelligence'],
    ml: ['machine learning'],
    nlp: ['natural language processing'],
    orm: ['object relational mapping'],
    sql: ['structured query language'],
    dag: ['directed acyclic graph'],
    rag: ['retrieval-augmented generation'],
  },
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function toCsv(
  rows: Array<Record<string, unknown>>,
  columns: Array<{ key: string; label: string }>,
): string {
  const escapeCell = (val: unknown): string => {
    if (val === null || val === undefined) return '';
    let str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (
      str.includes(',') ||
      str.includes('"') ||
      str.includes('\n') ||
      str.includes('\r')
    ) {
      str = `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = columns.map((c) => escapeCell(c.label)).join(',');
  const body = rows
    .map((row) => columns.map((c) => escapeCell(row[c.key])).join(','))
    .join('\r\n');

  return `\uFEFF${header}\r\n${body}`;
}
