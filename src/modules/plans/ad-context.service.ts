import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

import { DatabaseService } from '../../common/services/database.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import { RerankService } from '../../common/services/rerank.service.js';
import type {
  CreateAdContextTagDto,
  UpdateAdContextTagDto,
} from './plans.dto.js';

export type AdContextTagRecord = {
  id: string;
  name: string;
  slug: string;
  description: string;
  enabled: boolean;
  sendCount: number;
  matchCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AdContextTagStats = {
  totalTags: number;
  enabledTags: number;
  totalMatches: number;
  totalSends: number;
  topMatchedTags: Array<{ name: string; slug: string; matchCount: number }>;
  topSentTags: Array<{ name: string; slug: string; sendCount: number }>;
};

export type ResolvedGraphAdContext = {
  graphId: string;
  tags: string[];
  details: Array<{
    id: string;
    name: string;
    slug: string;
    score: number;
  }>;
};

export function slugifyTag(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

@Injectable()
export class AdContextService {
  private readonly logger = new Logger(AdContextService.name);

  constructor(
    private readonly database: DatabaseService,
    @Optional() private readonly rerankService?: RerankService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /**
   * Retrieves all predefined ad context tags.
   */
  async getAllTags(includeDisabled = true): Promise<AdContextTagRecord[]> {
    const query = includeDisabled
      ? 'SELECT * FROM "AdContextTag" ORDER BY "name" ASC'
      : 'SELECT * FROM "AdContextTag" WHERE "enabled" = true ORDER BY "name" ASC';

    const rows = await this.database.query<any>(query);
    return rows.map((r) => this.mapTagRecord(r));
  }

  /**
   * Retrieves an individual tag by ID.
   */
  async getTagById(id: string): Promise<AdContextTagRecord> {
    const row = await this.database.one<any>(
      'SELECT * FROM "AdContextTag" WHERE "id" = $1',
      [id],
    );
    if (!row) {
      throw new NotFoundException(`AdContextTag with ID "${id}" not found.`);
    }
    return this.mapTagRecord(row);
  }

  /**
   * Creates a new predefined tag.
   */
  async createTag(dto: CreateAdContextTagDto): Promise<AdContextTagRecord> {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Tag name cannot be empty.');
    }
    const slug = dto.slug?.trim() ? slugifyTag(dto.slug) : slugifyTag(name);
    if (!slug) {
      throw new BadRequestException('A valid slug is required.');
    }

    const existing = await this.database.one<any>(
      'SELECT "id" FROM "AdContextTag" WHERE "slug" = $1',
      [slug],
    );
    if (existing) {
      throw new BadRequestException(
        `AdContextTag with slug "${slug}" already exists.`,
      );
    }

    const id = `tag-${randomUUID()}`;
    const enabled = dto.enabled ?? true;
    const description = dto.description.trim();

    await this.database.query(
      `INSERT INTO "AdContextTag" ("id", "name", "slug", "description", "enabled", "sendCount", "matchCount", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, name, slug, description, enabled],
    );

    await this.invalidateActiveTagsCache();
    return this.getTagById(id);
  }

  /**
   * Updates an existing predefined tag.
   */
  async updateTag(
    id: string,
    dto: UpdateAdContextTagDto,
  ): Promise<AdContextTagRecord> {
    const tag = await this.getTagById(id);

    const name = dto.name !== undefined ? dto.name.trim() : tag.name;
    const slug =
      dto.slug !== undefined
        ? slugifyTag(dto.slug)
        : dto.name !== undefined
          ? slugifyTag(name)
          : tag.slug;
    const description =
      dto.description !== undefined ? dto.description.trim() : tag.description;
    const enabled = dto.enabled !== undefined ? dto.enabled : tag.enabled;

    if (slug !== tag.slug) {
      const conflict = await this.database.one<any>(
        'SELECT "id" FROM "AdContextTag" WHERE "slug" = $1 AND "id" != $2',
        [slug, id],
      );
      if (conflict) {
        throw new BadRequestException(
          `AdContextTag with slug "${slug}" already exists.`,
        );
      }
    }

    await this.database.query(
      `UPDATE "AdContextTag"
       SET "name" = $1, "slug" = $2, "description" = $3, "enabled" = $4, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $5`,
      [name, slug, description, enabled, id],
    );

    await this.invalidateActiveTagsCache();
    return this.getTagById(id);
  }

  /**
   * Deletes a predefined tag.
   */
  async deleteTag(id: string): Promise<{ success: boolean }> {
    await this.getTagById(id);
    await this.database.query('DELETE FROM "AdContextTag" WHERE "id" = $1', [
      id,
    ]);
    await this.invalidateActiveTagsCache();
    return { success: true };
  }

  /**
   * Aggregates usage statistics for ad contextualization tags.
   */
  async getTagStats(): Promise<AdContextTagStats> {
    const tags = await this.getAllTags(true);
    const enabledTags = tags.filter((t) => t.enabled).length;
    const totalMatches = tags.reduce((acc, t) => acc + t.matchCount, 0);
    const totalSends = tags.reduce((acc, t) => acc + t.sendCount, 0);

    const topMatchedTags = [...tags]
      .sort((a, b) => b.matchCount - a.matchCount)
      .slice(0, 5)
      .map((t) => ({ name: t.name, slug: t.slug, matchCount: t.matchCount }));

    const topSentTags = [...tags]
      .sort((a, b) => b.sendCount - a.sendCount)
      .slice(0, 5)
      .map((t) => ({ name: t.name, slug: t.slug, sendCount: t.sendCount }));

    return {
      totalTags: tags.length,
      enabledTags,
      totalMatches,
      totalSends,
      topMatchedTags,
      topSentTags,
    };
  }

  /**
   * Matches a processed source against the predefined ad taxonomy using TEI reranker.
   * If TEI reranker is unavailable, falls back to deterministic term-overlap matching.
   */
  async matchSourceWithTags(
    sourceId: string,
    graphId: string,
    sourceName: string,
    sourceContent?: string | null,
    vocabItems?: Array<{ term: string; weight: number }>,
  ): Promise<string[]> {
    const activeTags = await this.getAllTags(false);
    if (activeTags.length === 0) {
      return [];
    }

    const topConcepts = (vocabItems || [])
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 8)
      .map((v) => v.term);

    const sourceContextText = [
      sourceName,
      topConcepts.length > 0
        ? `Key concepts: ${topConcepts.join(', ')}`
        : undefined,
      (sourceContent || '').slice(0, 300),
    ]
      .filter(Boolean)
      .join('. ');

    const tagDescriptions = activeTags.map(
      (t) => `${t.name}: ${t.description}`,
    );

    const scoredMatches: Array<{ tagId: string; slug: string; score: number }> =
      [];

    // 1. Try TEI Reranker
    if (this.rerankService?.isConfigured()) {
      try {
        const rerankResults = await this.rerankService.rerank(
          sourceContextText,
          tagDescriptions,
        );
        if (rerankResults && rerankResults.length > 0) {
          for (const res of rerankResults) {
            const tag = activeTags[res.index];
            if (tag && res.score >= 0.2) {
              scoredMatches.push({
                tagId: tag.id,
                slug: tag.slug,
                score: res.score,
              });
            }
          }
        }
      } catch (err) {
        this.logger.warn(`TEI rerank matching error: ${err}`);
      }
    }

    // 2. Fallback: Semantic term overlap heuristic
    if (scoredMatches.length === 0) {
      const sourceTokens = new Set(
        sourceContextText
          .toLowerCase()
          .split(/[^\w]+/)
          .filter(Boolean),
      );

      for (const tag of activeTags) {
        const tagTokens = `${tag.name} ${tag.description}`
          .toLowerCase()
          .split(/[^\w]+/)
          .filter((w) => w.length > 3);

        let overlap = 0;
        for (const token of tagTokens) {
          if (sourceTokens.has(token)) {
            overlap++;
          }
        }

        if (overlap >= 2) {
          const score = Math.min(1.0, 0.3 + overlap * 0.15);
          scoredMatches.push({ tagId: tag.id, slug: tag.slug, score });
        }
      }
    }

    // Sort by score descending and take top 3
    scoredMatches.sort((a, b) => b.score - a.score);
    const topMatches = scoredMatches.slice(0, 3);

    // Persist matches to SourceAdTag
    await this.setSourceAdTags(
      sourceId,
      graphId,
      topMatches.map((m) => ({ tagId: m.tagId, score: m.score })),
    );

    return topMatches.map((m) => m.slug);
  }

  /**
   * Persists matched tags for a source, recalculates match counts, and invalidates graph context.
   */
  async setSourceAdTags(
    sourceId: string,
    graphId: string,
    matches: Array<{ tagId: string; score: number }>,
  ): Promise<void> {
    try {
      await this.database.query(
        'DELETE FROM "SourceAdTag" WHERE "sourceId" = $1',
        [sourceId],
      );

      for (const match of matches) {
        await this.database.query(
          `INSERT INTO "SourceAdTag" ("id", "sourceId", "tagId", "score", "createdAt")
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
           ON CONFLICT ("sourceId", "tagId") DO UPDATE SET "score" = EXCLUDED."score"`,
          [randomUUID(), sourceId, match.tagId, match.score],
        );
      }

      await this.recalculateMatchCounts();
      await this.invalidateGraphContext(graphId);
    } catch (err) {
      this.logger.warn(
        `Failed to persist source ad tag matches for ${sourceId}: ${err}`,
      );
    }
  }

  /**
   * Recalculates matchCount on AdContextTag based on active SourceAdTag associations.
   */
  async recalculateMatchCounts(): Promise<void> {
    try {
      await this.database.query(`
        UPDATE "AdContextTag"
        SET "matchCount" = (
          SELECT COUNT(DISTINCT "sourceId") FROM "SourceAdTag" WHERE "tagId" = "AdContextTag"."id"
        )
      `);
    } catch (err) {
      this.logger.warn(`Failed to recalculate ad tag match counts: ${err}`);
    }
  }

  /**
   * Immediately invalidates the cached graph contextual tags in Redis.
   */
  async invalidateGraphContext(graphId: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(`graph:${graphId}:ad-context`);
      } catch (err) {
        this.logger.warn(
          `Failed to invalidate graph ad context for ${graphId}: ${err}`,
        );
      }
    }
  }

  /**
   * Retrieves all currently active ad context tags (for worker use).
   */
  async getActiveTags(): Promise<AdContextTagRecord[]> {
    return this.database.query<AdContextTagRecord>(
      'SELECT * FROM "AdContextTag" WHERE "enabled" = TRUE ORDER BY "name" ASC',
    );
  }

  /**
   * Resolves the top contextual tags for a spatial graph based on matching sources.
   */
  async getGraphContextualTags(
    graphId: string,
  ): Promise<ResolvedGraphAdContext> {
    const cacheKey = `graph:${graphId}:ad-context`;
    if (this.redis) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          return JSON.parse(cached) as ResolvedGraphAdContext;
        }
      } catch {
        // Fall through to database
      }
    }

    const rows = await this.database.query<any>(
      `SELECT t."id", t."name", t."slug", SUM(sat."score") as "totalScore", COUNT(sat."sourceId") as "frequency"
       FROM "SourceAdTag" sat
       JOIN "AdContextTag" t ON sat."tagId" = t."id"
       JOIN "NodeSource" s ON sat."sourceId" = s."id"
       WHERE s."graphId" = $1 AND t."enabled" = true
       GROUP BY t."id", t."name", t."slug"
       ORDER BY "totalScore" DESC, "frequency" DESC
       LIMIT 3`,
      [graphId],
    );

    const details = rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      score: Number.parseFloat(r.totalScore ?? '1.0'),
    }));

    const result: ResolvedGraphAdContext = {
      graphId,
      tags: details.map((d) => d.slug),
      details,
    };

    if (this.redis) {
      void this.redis
        .set(cacheKey, JSON.stringify(result), 600)
        .catch(() => {});
    }

    return result;
  }

  /**
   * Increments the sendCount for tags when an impression is served.
   */
  async recordTagImpression(slugs: string[]): Promise<void> {
    if (!slugs || slugs.length === 0) return;
    try {
      await this.database.query(
        `UPDATE "AdContextTag"
         SET "sendCount" = "sendCount" + 1
         WHERE "slug" = ANY($1)`,
        [slugs],
      );
    } catch (err) {
      this.logger.warn(`Failed to update tag send count: ${err}`);
    }
  }

  private mapTagRecord(row: any): AdContextTagRecord {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      enabled: Boolean(row.enabled),
      sendCount: Number(row.sendCount ?? 0),
      matchCount: Number(row.matchCount ?? 0),
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt),
      updatedAt:
        row.updatedAt instanceof Date
          ? row.updatedAt.toISOString()
          : String(row.updatedAt),
    };
  }

  private async invalidateActiveTagsCache(): Promise<void> {
    if (this.redis) {
      await this.redis.del('ad-tags:active');
    }
  }
}
