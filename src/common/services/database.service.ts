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
    this.logger.log('Connected to PostgreSQL');
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
