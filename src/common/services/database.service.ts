import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type QueryResultRow } from 'pg';

import { authDatabase } from '../../auth.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool = authDatabase;

  constructor(config: ConfigService) {
    config.getOrThrow<string>('DATABASE_URL');
  }

  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "GraphAttachment" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        "graphId" TEXT NOT NULL REFERENCES "Graph"("id") ON DELETE CASCADE,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "GraphAttachment_userId_graphId_key" ON "GraphAttachment"("userId", "graphId");
      CREATE INDEX IF NOT EXISTS "GraphAttachment_userId_idx" ON "GraphAttachment"("userId");
      CREATE INDEX IF NOT EXISTS "GraphAttachment_graphId_idx" ON "GraphAttachment"("graphId");

      ALTER TABLE "Graph" ADD COLUMN IF NOT EXISTS "lastAccessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE "Graph" ADD COLUMN IF NOT EXISTS "scheduledForDeletionAt" TIMESTAMP(3);
      ALTER TABLE "Graph" ADD COLUMN IF NOT EXISTS "isExemptFromRetention" BOOLEAN NOT NULL DEFAULT false;
      CREATE INDEX IF NOT EXISTS "Graph_lastAccessedAt_idx" ON "Graph"("lastAccessedAt");
      CREATE INDEX IF NOT EXISTS "Graph_scheduledForDeletionAt_idx" ON "Graph"("scheduledForDeletionAt");
      CREATE INDEX IF NOT EXISTS "Graph_isExemptFromRetention_idx" ON "Graph"("isExemptFromRetention");

      CREATE TABLE IF NOT EXISTS "Notification" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        "type" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "message" TEXT NOT NULL,
        "data" JSONB,
        "isRead" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");
      CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

      CREATE TABLE IF NOT EXISTS "GraphArchive" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "graphId" TEXT NOT NULL UNIQUE,
        "userId" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "archiveUrl" TEXT NOT NULL,
        "sizeBytes" INTEGER NOT NULL DEFAULT 0,
        "sourceCount" INTEGER NOT NULL DEFAULT 0,
        "expiresAt" TIMESTAMP(3) NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS "GraphArchive_userId_idx" ON "GraphArchive"("userId");
      CREATE INDEX IF NOT EXISTS "GraphArchive_expiresAt_idx" ON "GraphArchive"("expiresAt");
    `);
    this.logger.log(
      'Connected to PostgreSQL and verified schema constraints, retention fields, notifications, and archives',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async query<Row extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<Row[]> {
    const result = await this.pool.query<Row>(text, values);
    return result.rows;
  }

  async one<Row extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<Row | undefined> {
    const [row] = await this.query<Row>(text, values);
    return row;
  }
}
