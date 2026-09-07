import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../../common/services/database.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import type { ViewerIdentity } from '../../common/types.js';
import { AuthService } from '../auth/auth.service.js';
import type {
  NotificationData,
  NotificationListResponse,
  NotificationResponse,
} from './notifications.dto.js';

type NotificationRecord = {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  data: NotificationData | null;
  isRead: boolean;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
    private readonly redis: RedisService,
  ) {}

  async list(
    identity: ViewerIdentity | undefined,
  ): Promise<NotificationListResponse> {
    if (!identity || identity.isGuest) {
      return { items: [], unreadCount: 0 };
    }

    const rows = await this.database.query<NotificationRecord>(
      `SELECT "id", "userId", "type", "title", "message", "data", "isRead", "createdAt", "updatedAt"
       FROM "Notification"
       WHERE "userId" = $1
       ORDER BY "createdAt" DESC
       LIMIT 50`,
      [identity.userId],
    );

    const countRow = await this.database.one<{ count: string }>(
      `SELECT COUNT(*)::text AS "count"
       FROM "Notification"
       WHERE "userId" = $1 AND "isRead" = false`,
      [identity.userId],
    );

    return {
      items: rows.map((r) => this.mapRecord(r)),
      unreadCount: Number(countRow?.count ?? '0'),
    };
  }

  async markAsRead(
    identity: ViewerIdentity | undefined,
    id: string,
  ): Promise<NotificationResponse> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );

    const [updated] = await this.database.query<NotificationRecord>(
      `UPDATE "Notification"
       SET "isRead" = true, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1 AND "userId" = $2
       RETURNING "id", "userId", "type", "title", "message", "data", "isRead", "createdAt", "updatedAt"`,
      [id, viewer.userId],
    );

    if (!updated) {
      throw new NotFoundException('Notification not found.');
    }

    return this.mapRecord(updated);
  }

  async markAllAsRead(
    identity: ViewerIdentity | undefined,
  ): Promise<{ count: number }> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );

    const updated = await this.database.query<{ id: string }>(
      `UPDATE "Notification"
       SET "isRead" = true, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "userId" = $1 AND "isRead" = false
       RETURNING "id"`,
      [viewer.userId],
    );

    return { count: updated.length };
  }

  async delete(
    identity: ViewerIdentity | undefined,
    id: string,
  ): Promise<void> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );

    await this.database.query(
      `DELETE FROM "Notification" WHERE "id" = $1 AND "userId" = $2`,
      [id, viewer.userId],
    );
  }

  async createNotification(
    userId: string,
    input: {
      type: string;
      title: string;
      message: string;
      data?: NotificationData;
    },
  ): Promise<NotificationResponse> {
    const id = randomUUID();
    const dataJson = input.data ? JSON.stringify(input.data) : null;

    const [record] = await this.database.query<NotificationRecord>(
      `INSERT INTO "Notification" ("id", "userId", "type", "title", "message", "data", "isRead", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING "id", "userId", "type", "title", "message", "data", "isRead", "createdAt", "updatedAt"`,
      [id, userId, input.type, input.title, input.message, dataJson],
    );

    if (!record) {
      throw new Error('Failed to create notification.');
    }

    this.logger.debug(
      `Dispatched notification ${id} (${input.type}) for user ${userId}`,
    );

    const mapped = this.mapRecord(record);

    try {
      await this.redis.publish(
        'notification:new',
        JSON.stringify({ userId, notification: mapped }),
      );
    } catch (err) {
      this.logger.warn(`Failed to publish notification to Redis: ${err}`);
    }

    return mapped;
  }

  /**
   * Check if a warning notification for this graph was already created within the last N days.
   */
  async hasRecentWarning(
    userId: string,
    graphId: string,
    days = 7,
  ): Promise<boolean> {
    const row = await this.database.one<{ count: string }>(
      `SELECT COUNT(*)::text AS "count"
       FROM "Notification"
       WHERE "userId" = $1
         AND "type" = 'GRAPH_INACTIVITY_WARNING'
         AND "data"->>'graphId' = $2
         AND "createdAt" >= CURRENT_TIMESTAMP - ($3 || ' days')::interval`,
      [userId, graphId, days.toString()],
    );

    return Number(row?.count ?? '0') > 0;
  }

  private mapRecord(r: NotificationRecord): NotificationResponse {
    return {
      id: r.id,
      userId: r.userId,
      type: r.type,
      title: r.title,
      message: r.message,
      data: r.data,
      isRead: r.isRead,
      createdAt:
        r.createdAt instanceof Date
          ? r.createdAt.toISOString()
          : String(r.createdAt),
      updatedAt:
        r.updatedAt instanceof Date
          ? r.updatedAt.toISOString()
          : String(r.updatedAt),
    };
  }
}
