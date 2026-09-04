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
    `);
    this.logger.log(
      'Connected to PostgreSQL and verified GraphAttachment table',
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
