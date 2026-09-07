import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { basename } from 'path';

import { DatabaseService } from '../../common/services/database.service.js';
import { RabbitMqService } from '../../common/services/rabbitmq.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import { StorageService } from '../../common/services/storage.service.js';
import { WeaviateService } from '../../common/services/weaviate.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

export type PurgedGraphDetail = {
  graphId: string;
  title: string;
  sourcesPurged: number;
  storageObjectsPurged: number;
  estimatedSizeBytes?: number;
};

export type RetentionSweepResult = {
  dryRun: boolean;
  scheduled: {
    count: number;
    graphIds: string[];
  };
  purged: {
    count: number;
    details: PurgedGraphDetail[];
  };
  audit?: {
    exemptGraphsCount: number;
    estimatedReclaimBytes: number;
    archivedGraphsCount?: number;
  };
};

export type GraphArchiveRecord = {
  id: string;
  graphId: string;
  userId: string;
  title: string;
  archiveUrl: string;
  sizeBytes: number;
  sourceCount: number;
  expiresAt: Date;
  createdAt: Date;
};

@Injectable()
export class GraphRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphRetentionService.name);
  private timer: NodeJS.Timeout | null = null;

  readonly inactivityRetentionDays: number;
  readonly gracePeriodDays: number;
  readonly scheduleIntervalHours: number;
  readonly autoPurgeEnabled: boolean;

  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
    private readonly weaviate: WeaviateService,
    private readonly redis: RedisService,
    config: ConfigService,
    private readonly notifications?: NotificationsService,
    private readonly rabbitMq?: RabbitMqService,
  ) {
    this.inactivityRetentionDays = Number.parseInt(
      config.get<string>('GRAPH_INACTIVITY_RETENTION_DAYS', '90'),
      10,
    );
    this.gracePeriodDays = Number.parseInt(
      config.get<string>('GRAPH_RETENTION_GRACE_PERIOD_DAYS', '7'),
      10,
    );
    this.scheduleIntervalHours = Number.parseInt(
      config.get<string>('GRAPH_RETENTION_SCHEDULE_INTERVAL_HOURS', '24'),
      10,
    );
    this.autoPurgeEnabled =
      config.get<string>('GRAPH_RETENTION_AUTO_PURGE_ENABLED', 'true') ===
      'true';
  }

  onModuleInit(): void {
    if (!this.autoPurgeEnabled) {
      this.logger.log('Graph retention scheduled auto-purge is disabled.');
      return;
    }

    const intervalMs = Math.max(
      60_000,
      this.scheduleIntervalHours * 3600 * 1000,
    );
    this.logger.log(
      `Graph retention service initialized (inactivity: ${this.inactivityRetentionDays}d, grace: ${this.gracePeriodDays}d, interval: ${this.scheduleIntervalHours}h).`,
    );

    // Initial sweep delayed by 30 seconds to allow warm-up
    setTimeout(() => {
      void this.runRetentionSweep().catch((err: unknown) => {
        this.logger.warn(`Initial retention sweep failed: ${String(err)}`);
      });
    }, 30_000);

    this.timer = setInterval(() => {
      void this.runRetentionSweep().catch((err: unknown) => {
        this.logger.error(
          `Periodic retention sweep encountered an error: ${String(err)}`,
        );
      });
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Generates a consolidated cold-storage tar.gz archive of the graph and its source files
   * before permanent purge, and stores a GraphArchive record with a 30-day retention window.
   */
  async archiveGraphBeforePurge(graphId: string): Promise<{
    archiveUrl: string;
    sizeBytes: number;
    sourceCount: number;
  } | null> {
    const graph = await this.database.one<{
      id: string;
      title: string;
      description: string | null;
      userId: string;
      nodes: unknown;
      edges: unknown;
      createdAt: Date;
      updatedAt: Date;
    }>(
      `SELECT "id", "title", "description", "userId", "nodes", "edges", "createdAt", "updatedAt"
       FROM "Graph" WHERE "id" = $1`,
      [graphId],
    );

    if (!graph) return null;

    const sources = await this.database.query<{
      id: string;
      nodeId: string;
      name: string;
      fileType: string;
      fileUrl: string;
      fileHash: string;
      sizeBytes: number;
      content: string | null;
    }>(
      `SELECT "id", "nodeId", "name", "fileType", "fileUrl", "fileHash", "sizeBytes", "content"
       FROM "NodeSource" WHERE "graphId" = $1`,
      [graphId],
    );

    const sourceFiles: Array<{ filename: string; buffer: Buffer }> = [];
    for (const source of sources) {
      if (source.fileUrl && !source.fileUrl.startsWith('seed://')) {
        try {
          const fileData = await this.storage.getObject(source.fileUrl);
          if (fileData?.buffer) {
            const safeName = `${source.id}_${basename(source.name).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            sourceFiles.push({ filename: safeName, buffer: fileData.buffer });
          }
        } catch {
          // If a file cannot be read, continue archiving remaining files
        }
      }
    }

    const manifest = {
      graph: {
        id: graph.id,
        title: graph.title,
        description: graph.description,
        userId: graph.userId,
        nodes: graph.nodes,
        edges: graph.edges,
        createdAt: graph.createdAt,
        updatedAt: graph.updatedAt,
      },
      sources: sources.map((s) => ({
        id: s.id,
        nodeId: s.nodeId,
        name: s.name,
        fileType: s.fileType,
        fileUrl: s.fileUrl,
        fileHash: s.fileHash,
        sizeBytes: s.sizeBytes,
        content: s.content,
      })),
      archivedAt: new Date().toISOString(),
    };

    const archiveResult = await this.storage.archiveGraphData(
      graph.id,
      manifest,
      sourceFiles,
    );

    await this.database.query(
      `INSERT INTO "GraphArchive" ("id", "graphId", "userId", "title", "archiveUrl", "sizeBytes", "sourceCount", "expiresAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP)
       ON CONFLICT ("graphId") DO UPDATE SET
         "archiveUrl" = EXCLUDED."archiveUrl",
         "sizeBytes" = EXCLUDED."sizeBytes",
         "sourceCount" = EXCLUDED."sourceCount",
         "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '30 days'`,
      [
        randomUUID(),
        graph.id,
        graph.userId,
        graph.title,
        archiveResult.key,
        archiveResult.sizeBytes,
        sourceFiles.length,
      ],
    );

    this.logger.log(
      `Archived graph "${graph.title}" (${graph.id}) into ${archiveResult.key} (${archiveResult.sizeBytes} bytes, ${sourceFiles.length} sources).`,
    );

    return {
      archiveUrl: archiveResult.key,
      sizeBytes: archiveResult.sizeBytes,
      sourceCount: sourceFiles.length,
    };
  }

  /**
   * Reinstates a graph and its associated sources from a cold-storage tarball archive.
   */
  async restoreGraphFromArchive(
    archiveIdOrGraphId: string,
    userId?: string,
    isAdmin = false,
  ): Promise<{
    id: string;
    title: string;
    userId: string;
    sourceCount: number;
    restored: boolean;
  }> {
    const archive = await this.database.one<GraphArchiveRecord>(
      `SELECT "id", "graphId", "userId", "title", "archiveUrl", "sizeBytes", "sourceCount", "expiresAt", "createdAt"
       FROM "GraphArchive"
       WHERE "id" = $1 OR "graphId" = $1
       LIMIT 1`,
      [archiveIdOrGraphId],
    );

    if (!archive) {
      throw new NotFoundException(
        `No cold-storage archive found for identifier ${archiveIdOrGraphId}`,
      );
    }

    if (!isAdmin && userId && archive.userId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to restore this graph archive',
      );
    }

    const archiveFile = await this.storage.getObject(archive.archiveUrl);
    if (!archiveFile?.buffer) {
      throw new NotFoundException(
        `Archive file not found in storage at ${archive.archiveUrl}`,
      );
    }

    const extractedFiles = this.storage.extractTarGz(archiveFile.buffer);
    const manifestFile = extractedFiles.find((f) => f.name === 'manifest.json');
    if (!manifestFile) {
      throw new BadRequestException(
        'Invalid archive: manifest.json is missing',
      );
    }

    const manifest = JSON.parse(manifestFile.buffer.toString('utf8')) as {
      graph: {
        id: string;
        title: string;
        description?: string | null;
        userId: string;
        isPublic?: boolean;
        isPrepared?: boolean;
        nodes: unknown[];
        edges: unknown[];
      };
      sources: Array<{
        id: string;
        nodeId?: string;
        name: string;
        fileType: string;
        fileUrl: string;
        fileHash?: string;
        sizeBytes?: number;
        content?: string | null;
      }>;
    };

    const existingGraph = await this.database.one<{ id: string }>(
      'SELECT "id" FROM "Graph" WHERE "id" = $1',
      [manifest.graph.id],
    );

    if (existingGraph) {
      await this.database.query(
        `UPDATE "Graph"
         SET "title" = $2,
             "description" = $3,
             "nodes" = $4::jsonb,
             "edges" = $5::jsonb,
             "lastAccessedAt" = CURRENT_TIMESTAMP,
             "scheduledForDeletionAt" = NULL,
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1`,
        [
          manifest.graph.id,
          manifest.graph.title,
          manifest.graph.description ?? null,
          JSON.stringify(manifest.graph.nodes ?? []),
          JSON.stringify(manifest.graph.edges ?? []),
        ],
      );
    } else {
      await this.database.query(
        `INSERT INTO "Graph" (
           "id", "title", "description", "userId", "isPublic", "isPrepared",
           "nodes", "edges", "lastAccessedAt", "scheduledForDeletionAt",
           "isExemptFromRetention", "createdAt", "updatedAt"
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, CURRENT_TIMESTAMP, NULL, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          manifest.graph.id,
          manifest.graph.title,
          manifest.graph.description ?? null,
          manifest.graph.userId ?? archive.userId,
          manifest.graph.isPublic ?? false,
          manifest.graph.isPrepared ?? false,
          JSON.stringify(manifest.graph.nodes ?? []),
          JSON.stringify(manifest.graph.edges ?? []),
        ],
      );
    }

    if (this.weaviate) {
      try {
        await this.weaviate.ensureTenant(manifest.graph.id);
      } catch (tenantErr) {
        this.logger.warn(
          `Failed to ensure Weaviate tenant for restored graph ${manifest.graph.id}: ${tenantErr}`,
        );
      }
    }

    const sourcesList = manifest.sources ?? [];
    for (const s of sourcesList) {
      const expectedPrefix = `sources/${s.id}_`;
      const matchingFile = extractedFiles.find(
        (f) =>
          f.name.startsWith(expectedPrefix) || f.name === `sources/${s.name}`,
      );

      if (matchingFile) {
        await this.storage.putObject(
          s.fileUrl,
          matchingFile.buffer,
          s.fileType,
        );
      }

      const jobId = randomUUID();
      const initialStatus = this.rabbitMq ? 'PENDING' : 'READY';

      await this.database.query(
        `INSERT INTO "NodeSource" (
           "id", "nodeId", "graphId", "name", "fileType", "fileUrl", "fileHash",
           "sizeBytes", "status", "jobId", "content", "createdAt", "updatedAt"
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT ("id") DO UPDATE SET
           "content" = EXCLUDED."content",
           "status" = EXCLUDED."status",
           "jobId" = EXCLUDED."jobId",
           "updatedAt" = CURRENT_TIMESTAMP`,
        [
          s.id,
          s.nodeId ?? 'root',
          manifest.graph.id,
          s.name,
          s.fileType,
          s.fileUrl,
          s.fileHash ?? '',
          s.sizeBytes ?? matchingFile?.buffer.length ?? 0,
          initialStatus,
          jobId,
          s.content ?? null,
        ],
      );

      if (this.redis) {
        await this.redis
          .set(`JOB_${jobId}:PROGRESS`, '0', 3600)
          .catch(() => {});
      }

      if (this.rabbitMq) {
        try {
          await this.rabbitMq.publishParsingJob({
            jobId,
            sourceId: s.id,
            graphId: manifest.graph.id,
            nodeId: s.nodeId ?? 'root',
            filePath: s.fileUrl,
            fileName: s.name,
            fileHash: s.fileHash ?? '',
            priority: 5,
          });
          this.logger.log(
            `Dispatched vector re-indexing job ${jobId} for restored source "${s.name}" (${s.id}).`,
          );
        } catch (jobErr) {
          this.logger.warn(
            `Failed to publish parsing job for restored source ${s.id}: ${jobErr}`,
          );
        }
      }
    }

    await this.database.query('DELETE FROM "GraphArchive" WHERE "id" = $1', [
      archive.id,
    ]);

    if (this.notifications) {
      try {
        await this.notifications.createNotification(archive.userId, {
          type: 'GRAPH_RESTORED',
          title: 'Graph Restored from Cold Storage',
          message: `Graph "${archive.title}" has been successfully restored with ${sourcesList.length} source attachment(s).`,
          data: { graphId: manifest.graph.id },
        });
      } catch (notifErr) {
        this.logger.warn(
          `Failed to dispatch restoration notification: ${notifErr}`,
        );
      }
    }

    this.logger.log(
      `Restored graph "${manifest.graph.title}" (${manifest.graph.id}) from archive ${archive.id} with ${sourcesList.length} sources.`,
    );

    return {
      id: manifest.graph.id,
      title: manifest.graph.title,
      userId: archive.userId,
      sourceCount: sourcesList.length,
      restored: true,
    };
  }

  /**
   * Identifies graphs with no interaction for `inactivityRetentionDays` and
   * flags them with `scheduledForDeletionAt` (current time + grace period).
   * In dryRun mode, returns candidate metrics without modifying database or sending notifications.
   */
  async scheduleInactiveGraphs(
    inactivityDays = this.inactivityRetentionDays,
    gracePeriodDays = this.gracePeriodDays,
    dryRun = false,
  ): Promise<{ count: number; graphIds: string[] }> {
    const candidateGraphs = await this.database.query<{
      id: string;
      title: string;
      userId: string;
      lastAccessedAt: Date;
    }>(
      `SELECT "id", "title", "userId", "lastAccessedAt"
       FROM "Graph"
       WHERE "isPrepared" = false
         AND "isExemptFromRetention" = false
         AND "scheduledForDeletionAt" IS NULL
         AND "lastAccessedAt" < CURRENT_TIMESTAMP - ($1 || ' days')::interval`,
      [inactivityDays.toString()],
    );

    if (candidateGraphs.length === 0) {
      return { count: 0, graphIds: [] };
    }

    const graphIds = candidateGraphs.map((g) => g.id);

    if (dryRun) {
      this.logger.log(
        `[DRY-RUN] Would schedule ${candidateGraphs.length} graphs for deletion: ${graphIds.join(', ')}`,
      );
      return {
        count: candidateGraphs.length,
        graphIds,
      };
    }

    await this.database.query(
      `UPDATE "Graph"
       SET "scheduledForDeletionAt" = CURRENT_TIMESTAMP + ($1 || ' days')::interval
       WHERE "id" = ANY($2)`,
      [gracePeriodDays.toString(), graphIds],
    );

    const scheduledDeletionDate = new Date(
      Date.now() + gracePeriodDays * 24 * 60 * 60 * 1000,
    );

    for (const g of candidateGraphs) {
      this.logger.warn(
        `Graph "${g.title}" (${g.id}) inactive for >${inactivityDays} days. Scheduled for deletion in ${gracePeriodDays} days.`,
      );

      if (this.notifications && g.userId) {
        try {
          const hasRecent = await this.notifications.hasRecentWarning(
            g.userId,
            g.id,
            gracePeriodDays,
          );
          if (!hasRecent) {
            await this.notifications.createNotification(g.userId, {
              type: 'GRAPH_INACTIVITY_WARNING',
              title: 'Graph scheduled for deletion',
              message: `Graph "${g.title}" has been inactive for ${inactivityDays} days and is scheduled for deletion on ${scheduledDeletionDate.toLocaleDateString()} unless accessed.`,
              data: {
                graphId: g.id,
                scheduledForDeletionAt: scheduledDeletionDate.toISOString(),
              },
            });
          }
        } catch (notifErr) {
          this.logger.warn(
            `Failed to emit inactivity notification for graph ${g.id}: ${String(notifErr)}`,
          );
        }
      }
    }

    return {
      count: candidateGraphs.length,
      graphIds,
    };
  }

  /**
   * Permanently purges graphs whose `scheduledForDeletionAt` has elapsed.
   * In normal mode, cold-archives graph data first, then cascades deletion.
   * In dryRun mode, estimates reclaimable storage and candidates without modifying storage or database.
   */
  async purgeScheduledGraphs(dryRun = false): Promise<{
    count: number;
    details: PurgedGraphDetail[];
    estimatedReclaimBytes: number;
  }> {
    const expiredGraphs = await this.database.query<{
      id: string;
      title: string;
    }>(
      `SELECT "id", "title"
       FROM "Graph"
       WHERE "isPrepared" = false
         AND "scheduledForDeletionAt" IS NOT NULL
         AND "scheduledForDeletionAt" <= CURRENT_TIMESTAMP`,
    );

    if (expiredGraphs.length === 0) {
      return { count: 0, details: [], estimatedReclaimBytes: 0 };
    }

    const details: PurgedGraphDetail[] = [];
    let estimatedReclaimBytes = 0;

    for (const graph of expiredGraphs) {
      try {
        const sources = await this.database.query<{
          id: string;
          fileUrl: string;
          sizeBytes: number;
        }>(
          'SELECT "id", "fileUrl", "sizeBytes" FROM "NodeSource" WHERE "graphId" = $1',
          [graph.id],
        );

        const graphSizeBytes = sources.reduce(
          (sum, s) => sum + (Number(s.sizeBytes) || 0),
          0,
        );
        estimatedReclaimBytes += graphSizeBytes;

        if (dryRun) {
          details.push({
            graphId: graph.id,
            title: graph.title,
            sourcesPurged: sources.length,
            storageObjectsPurged: sources.filter(
              (s) => s.fileUrl && !s.fileUrl.startsWith('seed://'),
            ).length,
            estimatedSizeBytes: graphSizeBytes,
          });
          continue;
        }

        // 1. Cold storage archival before permanent purge
        try {
          await this.archiveGraphBeforePurge(graph.id);
        } catch (archiveErr) {
          this.logger.warn(
            `Cold archival before purge failed for ${graph.id}: ${String(archiveErr)}`,
          );
        }

        // 2. Cascade delete in Storage: prefix sources/{graphId} and individual objects
        let storageObjectsPurged = 0;
        storageObjectsPurged += await this.storage
          .deletePrefix(`sources/${graph.id}`)
          .catch(() => 0);

        for (const s of sources) {
          if (s.fileUrl && !s.fileUrl.startsWith('seed://')) {
            await this.storage.deleteObject(s.fileUrl).catch(() => undefined);
            storageObjectsPurged++;
          }
        }

        // 3. Cascade delete in Weaviate: delete whole vector tenant & embeddings
        await this.weaviate.deleteTenant(graph.id).catch((err) => {
          this.logger.warn(
            `Failed to delete Weaviate tenant for ${graph.id}: ${String(err)}`,
          );
        });

        // 4. Clean up any Redis progress keys or caches
        await this.redis.del(`graph:${graph.id}:*`).catch(() => undefined);

        // 5. Cascade delete in PostgreSQL database
        await this.database.query('DELETE FROM "Graph" WHERE "id" = $1', [
          graph.id,
        ]);

        this.logger.log(
          `Purged inactive graph "${graph.title}" (${graph.id}): ${sources.length} sources and ${storageObjectsPurged} storage items removed.`,
        );

        details.push({
          graphId: graph.id,
          title: graph.title,
          sourcesPurged: sources.length,
          storageObjectsPurged,
          estimatedSizeBytes: graphSizeBytes,
        });
      } catch (err: unknown) {
        this.logger.error(
          `Failed to purge graph ${graph.id} (${graph.title}): ${String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }

    return {
      count: details.length,
      details,
      estimatedReclaimBytes,
    };
  }

  async getEffectiveRetentionSettings(): Promise<{
    retentionDays: number;
    gracePeriodDays: number;
  }> {
    try {
      const raw = await this.redis.get('system:settings');
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          retentionDays:
            Number(parsed.retentionDays) || this.inactivityRetentionDays,
          gracePeriodDays:
            Number(parsed.retentionGraceDays) || this.gracePeriodDays,
        };
      }
    } catch {
      // fallback
    }
    return {
      retentionDays: this.inactivityRetentionDays,
      gracePeriodDays: this.gracePeriodDays,
    };
  }

  /**
   * Executes a full retention sweep: schedule newly inactive graphs, then purge expired ones.
   */
  async runRetentionSweep(options?: {
    dryRun?: boolean;
  }): Promise<RetentionSweepResult> {
    const dryRun = options?.dryRun === true;
    const effective = await this.getEffectiveRetentionSettings();
    const scheduled = await this.scheduleInactiveGraphs(
      effective.retentionDays,
      effective.gracePeriodDays,
      dryRun,
    );
    const purged = await this.purgeScheduledGraphs(dryRun);

    const exemptRow = await this.database.one<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM "Graph" WHERE "isExemptFromRetention" = true',
    );
    const archiveRow = await this.database.one<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM "GraphArchive"',
    );

    return {
      dryRun,
      scheduled,
      purged: {
        count: purged.count,
        details: purged.details,
      },
      audit: {
        exemptGraphsCount: Number.parseInt(exemptRow?.count ?? '0', 10),
        estimatedReclaimBytes: purged.estimatedReclaimBytes,
        archivedGraphsCount: Number.parseInt(archiveRow?.count ?? '0', 10),
      },
    };
  }

  /**
   * Returns complete audit metrics for platform administrators.
   */
  async getAuditStats(): Promise<{
    inactiveCandidateCount: number;
    scheduledForDeletionCount: number;
    exemptGraphsCount: number;
    activeArchivesCount: number;
    totalActiveGraphs: number;
    estimatedReclaimBytes: number;
  }> {
    const effective = await this.getEffectiveRetentionSettings();
    const [inactiveRow] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text as count
       FROM "Graph"
       WHERE "isPrepared" = false
         AND "isExemptFromRetention" = false
         AND "scheduledForDeletionAt" IS NULL
         AND "lastAccessedAt" < CURRENT_TIMESTAMP - ($1 || ' days')::interval`,
      [effective.retentionDays.toString()],
    );

    const [scheduledRow] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text as count
       FROM "Graph"
       WHERE "isPrepared" = false
         AND "scheduledForDeletionAt" IS NOT NULL`,
    );

    const [exemptRow] = await this.database.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM "Graph" WHERE "isExemptFromRetention" = true',
    );

    const [archiveRow] = await this.database.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM "GraphArchive"',
    );

    const [totalRow] = await this.database.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM "Graph"',
    );

    const [bytesRow] = await this.database.query<{ totalBytes: string }>(
      `SELECT COALESCE(SUM(s."sizeBytes"), 0)::text as "totalBytes"
       FROM "NodeSource" s
       JOIN "Graph" g ON g."id" = s."graphId"
       WHERE g."scheduledForDeletionAt" IS NOT NULL`,
    );

    return {
      inactiveCandidateCount: Number.parseInt(inactiveRow?.count ?? '0', 10),
      scheduledForDeletionCount: Number.parseInt(
        scheduledRow?.count ?? '0',
        10,
      ),
      exemptGraphsCount: Number.parseInt(exemptRow?.count ?? '0', 10),
      activeArchivesCount: Number.parseInt(archiveRow?.count ?? '0', 10),
      totalActiveGraphs: Number.parseInt(totalRow?.count ?? '0', 10),
      estimatedReclaimBytes: Number.parseInt(bytesRow?.totalBytes ?? '0', 10),
    };
  }

  /**
   * Retrieves active graph archives, optionally filtered by user.
   */
  async getArchives(userId?: string): Promise<GraphArchiveRecord[]> {
    if (userId) {
      return this.database.query<GraphArchiveRecord>(
        'SELECT * FROM "GraphArchive" WHERE "userId" = $1 ORDER BY "createdAt" DESC',
        [userId],
      );
    }
    return this.database.query<GraphArchiveRecord>(
      'SELECT * FROM "GraphArchive" ORDER BY "createdAt" DESC',
    );
  }

  /**
   * Retrieves archive record by graphId.
   */
  async getArchiveByGraphId(
    graphId: string,
  ): Promise<GraphArchiveRecord | undefined> {
    return this.database.one<GraphArchiveRecord>(
      'SELECT * FROM "GraphArchive" WHERE "graphId" = $1',
      [graphId],
    );
  }

  /**
   * Explicitly cancels scheduled deletion and touches graph access.
   */
  async cancelScheduledDeletion(graphId: string): Promise<boolean> {
    const res = await this.database.query(
      `UPDATE "Graph"
       SET "scheduledForDeletionAt" = NULL,
           "lastAccessedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1 AND "scheduledForDeletionAt" IS NOT NULL
       RETURNING "id"`,
      [graphId],
    );
    return res.length > 0;
  }
}
