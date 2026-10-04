import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

import { DatabaseService } from '../../common/services/database.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import type { ViewerIdentity } from '../../common/types.js';
import type { AdContextService } from './ad-context.service.js';
import type { AdTelemetryDto, UpdatePlanDto } from './plans.dto.js';
import type {
  AdAnalyticsSummary,
  AdGraphRevenueItem,
  PlanDefinitionRecord,
  PlanLimits,
} from './plans.types.js';

export const DEFAULT_PLAN_LIMITS: Record<string, PlanLimits> = {
  ANONYMOUS: {
    maxNodes: 0,
    maxSourcesPerGraph: 0,
    maxSourceSizeBytes: 0,
    maxSelectedNodes: 2,
    maxGraphs: 0,
    maxPrivateGraphs: 0,
    allowedCrawlDepths: ['shallow'],
    allowedHypothesisGroups: 0,
    pdfUploadsAllowed: false,
    maxUploadsPerHour: 0,
  },
  REGISTERED: {
    maxNodes: null,
    maxSourcesPerGraph: null,
    maxSourceSizeBytes: 50 * 1024 * 1024,
    maxSelectedNodes: null,
    maxGraphs: null,
    maxPrivateGraphs: null,
    allowedCrawlDepths: ['shallow', 'default', 'deep'],
    allowedHypothesisGroups: 4,
    pdfUploadsAllowed: true,
    maxUploadsPerHour: 50,
  },
};

@Injectable()
export class PlansService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlansService.name);
  private timer: NodeJS.Timeout | null = null;
  readonly autoRollupEnabled: boolean;
  readonly scheduleIntervalHours: number;
  readonly retentionDays: number;

  constructor(
    private readonly database: DatabaseService,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly adContextService?: AdContextService,
  ) {
    this.autoRollupEnabled =
      (config?.get<string>('AD_TELEMETRY_AUTO_ROLLUP_ENABLED') ?? 'true') !==
      'false';
    this.scheduleIntervalHours = Number.parseInt(
      config?.get<string>('AD_TELEMETRY_ROLLUP_SCHEDULE_HOURS') ?? '24',
      10,
    );
    this.retentionDays = Number.parseInt(
      config?.get<string>('AD_TELEMETRY_RETENTION_DAYS') ?? '90',
      10,
    );
  }

  onModuleInit(): void {
    if (!this.autoRollupEnabled) {
      this.logger.log('Ad telemetry scheduled auto-rollup is disabled.');
      return;
    }

    const intervalMs = Math.max(
      60_000,
      this.scheduleIntervalHours * 3600 * 1000,
    );
    this.logger.log(
      `Ad telemetry scheduled rollup initialized (interval: ${this.scheduleIntervalHours}h, retention: ${this.retentionDays}d).`,
    );

    setTimeout(() => {
      void this.runScheduledRollupAndRetention().catch((err) => {
        this.logger.warn(`Initial ad telemetry rollup sweep failed: ${err}`);
      });
    }, 30_000);

    this.timer = setInterval(() => {
      void this.runScheduledRollupAndRetention().catch((err) => {
        this.logger.error(`Periodic ad telemetry rollup sweep failed: ${err}`);
      });
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runScheduledRollupAndRetention(): Promise<{
    rollup: { success: boolean; rowsRolledUp: number };
    retention: { success: boolean; purgedCount: number; retentionDays: number };
  }> {
    const rollupResult = await this.rollupAdTelemetryDaily();
    const retentionResult = await this.purgeOldAdTelemetryEvents(
      this.retentionDays,
    );
    return { rollup: rollupResult, retention: retentionResult };
  }

  /**
   * Retrieves all canonical plan definitions (ANONYMOUS, REGISTERED)
   */
  async getPlanDefinitions(): Promise<PlanDefinitionRecord[]> {
    const rows = await this.database.query<any>(
      `SELECT "id", "tier", "name", "description", "adsEnabled", "limits", "version", "createdAt", "updatedAt"
       FROM "PlanDefinition"
       WHERE "tier" IN ('ANONYMOUS', 'REGISTERED')
       ORDER BY CASE "tier" WHEN 'ANONYMOUS' THEN 1 WHEN 'REGISTERED' THEN 2 ELSE 3 END`,
    );

    if (rows.length === 0) {
      return this.fallbackPlanDefinitions();
    }

    return rows.map((r) => this.mapPlanRecord(r));
  }

  /**
   * Retrieves a single canonical plan definition by tier
   */
  async getPlanDefinition(tier: string): Promise<PlanDefinitionRecord> {
    const normalizedTier = tier.toUpperCase();
    const row = await this.database.one<any>(
      `SELECT "id", "tier", "name", "description", "adsEnabled", "limits", "version", "createdAt", "updatedAt"
       FROM "PlanDefinition" WHERE "tier" = $1`,
      [normalizedTier],
    );

    if (!row) {
      const fallback = this.fallbackPlanDefinitions().find(
        (p) => p.tier === normalizedTier,
      );
      if (fallback) return fallback;
      throw new NotFoundException(`Plan for tier ${tier} not found.`);
    }

    return this.mapPlanRecord(row);
  }

  /**
   * Updates an existing plan definition with strict validation
   */
  async updatePlanDefinition(
    tier: string,
    dto: UpdatePlanDto,
    actor?: ViewerIdentity,
  ): Promise<PlanDefinitionRecord> {
    const normalizedTier = tier.toUpperCase() as 'ANONYMOUS' | 'REGISTERED';
    if (!['ANONYMOUS', 'REGISTERED'].includes(normalizedTier)) {
      throw new BadRequestException(`Invalid plan tier: ${tier}`);
    }

    const current = await this.getPlanDefinition(normalizedTier);

    const mergedLimits: PlanLimits = {
      ...current.limits,
      ...(dto.limits ?? {}),
    };

    const nextVersion = (current.version || 1) + 1;
    const nextAdsEnabled =
      dto.adsEnabled !== undefined ? dto.adsEnabled : current.adsEnabled;
    const nextName = dto.name !== undefined ? dto.name : current.name;
    const nextDescription =
      dto.description !== undefined ? dto.description : current.description;

    const [updatedRow] = await this.database.query<any>(
      `UPDATE "PlanDefinition"
       SET "name" = $1,
           "description" = $2,
           "adsEnabled" = $3,
           "limits" = $4::jsonb,
           "version" = $5,
           "updatedAt" = CURRENT_TIMESTAMP
       WHERE "tier" = $6
       RETURNING "id", "tier", "name", "description", "adsEnabled", "limits", "version", "createdAt", "updatedAt"`,
      [
        nextName,
        nextDescription,
        nextAdsEnabled,
        JSON.stringify(mergedLimits),
        nextVersion,
        normalizedTier,
      ],
    );

    const mapped = this.mapPlanRecord(updatedRow);
    this.logger.log(
      `Plan definition for ${normalizedTier} updated to v${nextVersion} by actor: ${actor?.email ?? actor?.userId ?? 'admin'}`,
    );

    return mapped;
  }

  /**
   * Pre-aggregates daily ad telemetry records into AdTelemetryDailyRollup table for high-performance querying
   */
  async rollupAdTelemetryDaily(targetDate?: string): Promise<{
    success: boolean;
    targetDate?: string;
    rowsRolledUp: number;
  }> {
    try {
      let dateClause = `DATE("createdAt") < CURRENT_DATE`;
      const params: any[] = [];
      if (targetDate) {
        dateClause = `DATE("createdAt") = $1::date`;
        params.push(targetDate);
      }

      const query = `
        INSERT INTO "AdTelemetryDailyRollup" ("id", "date", "eventType", "consent", "totalCount", "totalDurationSeconds", "createdAt", "updatedAt")
        SELECT
          md5(DATE("createdAt")::text || ':' || "eventType" || ':' || COALESCE("consent", 'none')) as "id",
          DATE("createdAt") as "date",
          "eventType",
          "consent",
          COUNT(*)::int as "totalCount",
          COALESCE(SUM("durationSeconds"), 0)::float as "totalDurationSeconds",
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        FROM "AdTelemetryEvent"
        WHERE ${dateClause}
        GROUP BY DATE("createdAt"), "eventType", "consent"
        ON CONFLICT ("date", "eventType", "consent") DO UPDATE
        SET "totalCount" = EXCLUDED."totalCount",
            "totalDurationSeconds" = EXCLUDED."totalDurationSeconds",
            "updatedAt" = CURRENT_TIMESTAMP
        RETURNING "id"
      `;

      const rows = await this.database.query(query, params);
      this.logger.log(
        `Ad telemetry rollup completed: ${rows.length} rollups updated/inserted${targetDate ? ` for date ${targetDate}` : ''}`,
      );
      return {
        success: true,
        targetDate,
        rowsRolledUp: rows.length,
      };
    } catch (err: any) {
      this.logger.error(`Ad telemetry daily rollup failed: ${err?.message}`);
      return {
        success: false,
        targetDate,
        rowsRolledUp: 0,
      };
    }
  }

  /**
   * Safely purges raw AdTelemetryEvent records older than retentionDays (default 90)
   * ONLY IF their dates have been safely pre-aggregated into AdTelemetryDailyRollup.
   */
  async purgeOldAdTelemetryEvents(retentionDays = 90): Promise<{
    success: boolean;
    purgedCount: number;
    retentionDays: number;
  }> {
    try {
      const days = Math.max(1, retentionDays);
      const rows = await this.database.query<{ id: string }>(
        `DELETE FROM "AdTelemetryEvent"
         WHERE "createdAt" < NOW() - ($1 || ' days')::interval
           AND DATE("createdAt") IN (SELECT "date" FROM "AdTelemetryDailyRollup")
         RETURNING "id"`,
        [days],
      );

      const purgedCount = rows.length;
      if (purgedCount > 0) {
        this.logger.log(
          `Purged ${purgedCount} raw ad telemetry events older than ${days} days (pre-aggregated into daily rollups).`,
        );
      }

      return {
        success: true,
        purgedCount,
        retentionDays: days,
      };
    } catch (err: any) {
      this.logger.error(
        `Failed to purge old ad telemetry events: ${err?.message}`,
      );
      return {
        success: false,
        purgedCount: 0,
        retentionDays,
      };
    }
  }

  /**
   * Returns storage telemetry status: raw event count, rollups count, date ranges, and retention settings.
   */
  async getAdTelemetryStatus(): Promise<{
    totalEventsCount: number;
    totalRollupsCount: number;
    oldestEventDate: string | null;
    newestEventDate: string | null;
    lastRollupDate: string | null;
    retentionDays: number;
    autoRollupEnabled: boolean;
    scheduleIntervalHours: number;
  }> {
    const [eventsStat] = await this.database.query<{
      count: number | string;
      minDate: Date | null;
      maxDate: Date | null;
    }>(
      `SELECT COUNT(*)::int as count, MIN("createdAt") as "minDate", MAX("createdAt") as "maxDate" FROM "AdTelemetryEvent"`,
    );

    const [rollupsStat] = await this.database.query<{
      count: number | string;
      lastDate: Date | string | null;
    }>(
      `SELECT COUNT(*)::int as count, MAX("date") as "lastDate" FROM "AdTelemetryDailyRollup"`,
    );

    return {
      totalEventsCount: Number(eventsStat?.count || 0),
      totalRollupsCount: Number(rollupsStat?.count || 0),
      oldestEventDate: eventsStat?.minDate
        ? new Date(eventsStat.minDate).toISOString()
        : null,
      newestEventDate: eventsStat?.maxDate
        ? new Date(eventsStat.maxDate).toISOString()
        : null,
      lastRollupDate: rollupsStat?.lastDate
        ? String(rollupsStat.lastDate).slice(0, 10)
        : null,
      retentionDays: this.retentionDays,
      autoRollupEnabled: this.autoRollupEnabled,
      scheduleIntervalHours: this.scheduleIntervalHours,
    };
  }

  /**
   * Records telemetry event from client (impressions, culling, pulses, refreshes, consent)
   */
  async recordAdTelemetry(dto: AdTelemetryDto): Promise<{ success: boolean }> {
    try {
      await this.database.query(
        `INSERT INTO "AdTelemetryEvent" ("id", "eventType", "format", "durationSeconds", "consent", "slotId", "graphId", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
        [
          randomUUID(),
          dto.eventType,
          dto.format || null,
          dto.durationSeconds || 0.0,
          dto.consent || null,
          dto.slotId || null,
          dto.graphId || null,
        ],
      );

      if (
        dto.tags &&
        dto.tags.length > 0 &&
        (dto.eventType === 'impression' ||
          dto.eventType === 'viewable_pulse') &&
        this.adContextService
      ) {
        void this.adContextService
          .recordTagImpression(dto.tags)
          .catch((err) => {
            this.logger.warn(`Failed to update tag impressions: ${err}`);
          });
      }
    } catch (err) {
      this.logger.warn(`Failed to insert ad telemetry event: ${err}`);
    }
    return { success: true };
  }

  /**
   * Retrieves active ad configuration parameters from Redis or PostgreSQL.
   */
  async getAdConfig(): Promise<{
    effectiveEcpm: number;
    canvasAdDensity: number;
    maxCanvasAds: number;
  }> {
    const DEFAULT_CONFIG = {
      effectiveEcpm: 1.5,
      canvasAdDensity: 35,
      maxCanvasAds: 5,
    };
    if (this.redis) {
      try {
        const raw = await this.redis.get('system:settings');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.adConfig) {
            return {
              effectiveEcpm:
                Number(parsed.adConfig.effectiveEcpm) ||
                DEFAULT_CONFIG.effectiveEcpm,
              canvasAdDensity:
                Number(parsed.adConfig.canvasAdDensity) ||
                DEFAULT_CONFIG.canvasAdDensity,
              maxCanvasAds:
                Number(parsed.adConfig.maxCanvasAds) ||
                DEFAULT_CONFIG.maxCanvasAds,
            };
          }
        }
      } catch {
        // Fall back to database query
      }
    }
    try {
      const rows = await this.database.query<{ value: any }>(
        `SELECT "value" FROM "SystemSettings" WHERE "key" = 'adConfig'`,
      );
      const firstRow = rows[0];
      if (firstRow?.value) {
        return {
          effectiveEcpm:
            Number(firstRow.value.effectiveEcpm) ||
            DEFAULT_CONFIG.effectiveEcpm,
          canvasAdDensity:
            Number(firstRow.value.canvasAdDensity) ||
            DEFAULT_CONFIG.canvasAdDensity,
          maxCanvasAds:
            Number(firstRow.value.maxCanvasAds) || DEFAULT_CONFIG.maxCanvasAds,
        };
      }
    } catch {
      // In case table not present
    }
    return DEFAULT_CONFIG;
  }

  /**
   * Aggregates ad telemetry metrics for administrative insights with optional historical date range filtering.
   */
  async getAdAnalytics(filter?: {
    range?: '7d' | '30d' | '90d' | 'all' | string;
    startDate?: string;
    endDate?: string;
  }): Promise<AdAnalyticsSummary> {
    const range = filter?.range || 'all';
    let rollupWhere = '';
    let eventWhere = '';
    const rollupParams: any[] = [];
    const eventParams: any[] = [];

    if (range === '7d') {
      rollupWhere = `WHERE "date" >= CURRENT_DATE - INTERVAL '7 days'`;
      eventWhere = `WHERE "createdAt" >= NOW() - INTERVAL '7 days'`;
    } else if (range === '30d') {
      rollupWhere = `WHERE "date" >= CURRENT_DATE - INTERVAL '30 days'`;
      eventWhere = `WHERE "createdAt" >= NOW() - INTERVAL '30 days'`;
    } else if (range === '90d') {
      rollupWhere = `WHERE "date" >= CURRENT_DATE - INTERVAL '90 days'`;
      eventWhere = `WHERE "createdAt" >= NOW() - INTERVAL '90 days'`;
    } else if (filter?.startDate && filter?.endDate) {
      rollupWhere = `WHERE "date" >= $1::date AND "date" <= $2::date`;
      rollupParams.push(new Date(filter.startDate), new Date(filter.endDate));
      eventWhere = `WHERE "createdAt" >= $1 AND "createdAt" <= $2`;
      eventParams.push(new Date(filter.startDate), new Date(filter.endDate));
    }

    const eventExcludeSubquery = `DATE("createdAt") NOT IN (SELECT "date" FROM "AdTelemetryDailyRollup")`;
    const finalEventWhere = eventWhere
      ? `${eventWhere} AND ${eventExcludeSubquery}`
      : `WHERE ${eventExcludeSubquery}`;

    const [rollupRows, eventRows] = await Promise.all([
      this.database.query<{
        eventType: string;
        consent: string | null;
        count: string | number;
        totalDuration: string | number | null;
      }>(
        `SELECT "eventType", "consent", SUM("totalCount")::int as "count", COALESCE(SUM("totalDurationSeconds"), 0)::float as "totalDuration"
         FROM "AdTelemetryDailyRollup"
         ${rollupWhere}
         GROUP BY "eventType", "consent"`,
        rollupParams,
      ),
      this.database.query<{
        eventType: string;
        consent: string | null;
        count: string | number;
        totalDuration: string | number | null;
      }>(
        `SELECT "eventType", "consent", COUNT(*)::int as "count", COALESCE(SUM("durationSeconds"), 0)::float as "totalDuration"
         FROM "AdTelemetryEvent"
         ${finalEventWhere}
         GROUP BY "eventType", "consent"`,
        eventParams,
      ),
    ]);

    const rows = [...rollupRows, ...eventRows];

    let totalImpressions = 0;
    let totalCulled = 0;
    let totalRefreshes = 0;
    let totalActiveViewableSeconds = 0;
    let personalized = 0;
    let contextual = 0;
    let declined = 0;

    for (const r of rows) {
      const count = Number(r.count);
      const duration = Number(r.totalDuration || 0);

      if (r.eventType === 'impression') {
        totalImpressions += count;
        totalActiveViewableSeconds += duration;
      } else if (r.eventType === 'culled') {
        totalCulled += count;
      } else if (r.eventType === 'refresh') {
        totalRefreshes += count;
      } else if (r.eventType === 'viewable_pulse') {
        totalActiveViewableSeconds += duration;
      }

      if (r.consent === 'granted') {
        personalized += count;
      } else if (r.consent === 'essential_only') {
        contextual += count;
      } else if (r.consent === 'denied') {
        declined += count;
      }
    }

    const adConfig = await this.getAdConfig();
    const effectiveEcpm = adConfig.effectiveEcpm;
    const averageViewabilitySeconds =
      totalImpressions > 0
        ? Number((totalActiveViewableSeconds / totalImpressions).toFixed(1))
        : 0;
    const estimatedRevenueUsd = Number(
      ((totalImpressions / 1000) * effectiveEcpm).toFixed(2),
    );
    const totalPotential = totalImpressions + totalCulled;
    const gpuSavingsPercentage =
      totalPotential > 0
        ? Number(((totalCulled / totalPotential) * 100).toFixed(1))
        : 0;

    let topGraphs: AdGraphRevenueItem[] = [];
    try {
      let graphWhere = `WHERE e."graphId" IS NOT NULL`;
      const graphParams: any[] = [];
      if (range === '7d') {
        graphWhere += ` AND e."createdAt" >= NOW() - INTERVAL '7 days'`;
      } else if (range === '30d') {
        graphWhere += ` AND e."createdAt" >= NOW() - INTERVAL '30 days'`;
      } else if (range === '90d') {
        graphWhere += ` AND e."createdAt" >= NOW() - INTERVAL '90 days'`;
      } else if (filter?.startDate && filter?.endDate) {
        graphWhere += ` AND e."createdAt" >= $1 AND e."createdAt" <= $2`;
        graphParams.push(new Date(filter.startDate), new Date(filter.endDate));
      }

      const graphRows = await this.database.query<{
        graphId: string;
        graphName: string | null;
        isPublic: boolean | null;
        impressions: string | number;
        activeViewableSeconds: string | number;
      }>(
        `SELECT
           e."graphId",
           g."title" as "graphName",
           g."isPublic" as "isPublic",
           COUNT(*) FILTER (WHERE e."eventType" = 'impression')::int as "impressions",
           COALESCE(SUM(e."durationSeconds") FILTER (WHERE e."eventType" IN ('impression', 'viewable_pulse', 'refresh')), 0)::float as "activeViewableSeconds"
         FROM "AdTelemetryEvent" e
         LEFT JOIN "Graph" g ON g."id" = e."graphId"
         ${graphWhere}
         GROUP BY e."graphId", g."title", g."isPublic"
         HAVING COUNT(*) FILTER (WHERE e."eventType" = 'impression') > 0
         ORDER BY "impressions" DESC, "activeViewableSeconds" DESC
         LIMIT 10`,
        graphParams,
      );

      topGraphs = graphRows.map((r) => {
        const imps = Number(r.impressions || 0);
        const viewSecs = Number(
          Number(r.activeViewableSeconds || 0).toFixed(1),
        );
        const estRev = Number(((imps / 1000) * effectiveEcpm).toFixed(2));
        return {
          graphId: r.graphId,
          graphName: r.graphName || `Graph ${r.graphId.slice(0, 8)}`,
          isPublic: r.isPublic ?? false,
          impressions: imps,
          activeViewableSeconds: viewSecs,
          estimatedRevenueUsd: estRev,
        };
      });
    } catch {
      // In case of query fallback
    }

    return {
      totalImpressions,
      totalCulled,
      totalRefreshes,
      averageViewabilitySeconds,
      totalActiveViewableSeconds: Number(totalActiveViewableSeconds.toFixed(1)),
      consentBreakdown: {
        personalized,
        contextual,
        declined,
      },
      estimatedRevenueUsd,
      effectiveEcpm,
      gpuSavingsPercentage,
      range,
      topGraphs,
    };
  }

  /**
   * Exports ad telemetry records as CSV string for administrative auditing
   */
  async exportAdTelemetryCsv(
    range?: '7d' | '30d' | '90d' | 'all' | string,
  ): Promise<string> {
    const r = range || 'all';
    let whereClause = '';

    if (r === '7d') {
      whereClause = `WHERE "createdAt" >= NOW() - INTERVAL '7 days'`;
    } else if (r === '30d') {
      whereClause = `WHERE "createdAt" >= NOW() - INTERVAL '30 days'`;
    } else if (r === '90d') {
      whereClause = `WHERE "createdAt" >= NOW() - INTERVAL '90 days'`;
    }

    const rows = await this.database.query<{
      id: string;
      eventType: string;
      format: string | null;
      durationSeconds: number | null;
      consent: string | null;
      slotId: string | null;
      graphId: string | null;
      createdAt: Date | string;
    }>(
      `SELECT "id", "eventType", "format", "durationSeconds", "consent", "slotId", "graphId", "createdAt"
       FROM "AdTelemetryEvent"
       ${whereClause}
       ORDER BY "createdAt" DESC
       LIMIT 5000`,
    );

    const escapeCsv = (val: string | number | null | undefined) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const header = [
      'id',
      'eventType',
      'format',
      'durationSeconds',
      'consent',
      'slotId',
      'graphId',
      'createdAt',
    ];
    const lines = [header.join(',')];

    for (const row of rows) {
      lines.push(
        [
          escapeCsv(row.id),
          escapeCsv(row.eventType),
          escapeCsv(row.format),
          row.durationSeconds !== null
            ? Number(row.durationSeconds).toFixed(1)
            : '0.0',
          escapeCsv(row.consent),
          escapeCsv(row.slotId),
          escapeCsv(row.graphId),
          escapeCsv(
            row.createdAt instanceof Date
              ? row.createdAt.toISOString()
              : String(row.createdAt),
          ),
        ].join(','),
      );
    }

    return lines.join('\n');
  }

  private mapPlanRecord(raw: any): PlanDefinitionRecord {
    return {
      id: raw.id,
      tier: raw.tier,
      name: raw.name,
      description: raw.description,
      adsEnabled: Boolean(raw.adsEnabled),
      limits:
        typeof raw.limits === 'string'
          ? JSON.parse(raw.limits)
          : (raw.limits ?? {}),
      version: Number(raw.version || 1),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  private fallbackPlanDefinitions(): PlanDefinitionRecord[] {
    const now = new Date().toISOString();
    return [
      {
        id: 'plan-anon',
        tier: 'ANONYMOUS',
        name: 'Anonymous Guest',
        description:
          'Instant guest exploration with single-seed shallow crawl.',
        adsEnabled: true,
        limits: DEFAULT_PLAN_LIMITS.ANONYMOUS!,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'plan-registered',
        tier: 'REGISTERED',
        name: 'Registered User',
        description:
          'Full graph creation and deep multi-hop traversal with 100MB source storage.',
        adsEnabled: true,
        limits: DEFAULT_PLAN_LIMITS.REGISTERED!,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
