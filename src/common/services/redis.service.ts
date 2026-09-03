import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

type LocalValue = { value: string; expiresAt: number };

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private readonly localValues = new Map<string, LocalValue>();
  private available = false;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis unavailable: ${error.message}`);
      this.available = false;
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      this.available = true;
      this.logger.log('Connected to Redis');
    } catch (error: unknown) {
      this.logger.warn(
        `Using in-memory development fallback: ${this.message(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.available) {
      await this.client.quit();
    }
  }

  async consumeQuota(
    identifier: string,
    limit: number,
  ): Promise<{ allowed: boolean; remaining: number }> {
    const key = `usage:${identifier}:${new Date().toISOString().slice(0, 10)}`;
    const now = new Date();
    const nextUtcDay = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    const ttlSeconds = Math.max(
      1,
      Math.ceil((nextUtcDay - now.getTime()) / 1000),
    );
    const count = await this.increment(key, ttlSeconds);
    return { allowed: count <= limit, remaining: Math.max(limit - count, 0) };
  }

  async consumeUploadQuota(
    identifier: string,
    limit = 10,
  ): Promise<{ allowed: boolean; remaining: number }> {
    const key = `uploads:${identifier}:${new Date().toISOString().slice(0, 13)}`;
    const count = await this.increment(key, 3600);
    return { allowed: count <= limit, remaining: Math.max(limit - count, 0) };
  }

  async consumeRateLimit(
    scope: string,
    identifier: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{
    success: boolean;
    limit: number;
    remaining: number;
    reset: number;
  }> {
    const window = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `rate:${scope}:${identifier}:${window}`;
    const count = await this.increment(key, windowSeconds * 2);
    return {
      success: count <= limit,
      limit,
      remaining: Math.max(limit - count, 0),
      reset: (window + 1) * windowSeconds * 1000,
    };
  }

  async registerGuestIp(ip: string, guestId: string): Promise<boolean> {
    const hour = new Date().toISOString().slice(0, 13);
    const key = `guest-ip:${ip}:${hour}`;
    if (this.available) {
      try {
        await this.client.sadd(key, guestId);
        await this.client.expire(key, 3600);
        return (await this.client.scard(key)) <= 10;
      } catch (error: unknown) {
        this.available = false;
        this.logger.warn(
          `Redis guest limiter fallback: ${this.message(error)}`,
        );
      }
    }

    const existing = this.readLocalSet(key);
    existing.add(guestId);
    this.localValues.set(key, {
      value: JSON.stringify([...existing]),
      expiresAt: Date.now() + 3_600_000,
    });
    return existing.size <= 10;
  }

  async get(key: string): Promise<string | null> {
    if (this.available) {
      try {
        return await this.client.get(key);
      } catch (error: unknown) {
        this.available = false;
        this.logger.warn(`Redis read fallback: ${this.message(error)}`);
      }
    }
    const local = this.localValues.get(key);
    if (!local || local.expiresAt <= Date.now()) {
      this.localValues.delete(key);
      return null;
    }
    return local.value;
  }

  async getDailyUsage(identifier: string): Promise<number> {
    const key = `usage:${identifier}:${new Date().toISOString().slice(0, 10)}`;
    return this.readCounter(key);
  }

  async getHourlyUploadUsage(identifier: string): Promise<number> {
    const key = `uploads:${identifier}:${new Date().toISOString().slice(0, 13)}`;
    return this.readCounter(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.available) {
      try {
        await this.client.set(key, value, 'EX', ttlSeconds);
        return;
      } catch (error: unknown) {
        this.available = false;
        this.logger.warn(`Redis write fallback: ${this.message(error)}`);
      }
    }
    this.localValues.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async ping(): Promise<boolean> {
    if (!this.available) {
      return false;
    }
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      this.available = false;
      return false;
    }
  }

  private async increment(key: string, ttlSeconds: number): Promise<number> {
    if (this.available) {
      try {
        const count = await this.client.incr(key);
        if (count === 1) {
          await this.client.expire(key, ttlSeconds);
        }
        return count;
      } catch (error: unknown) {
        this.available = false;
        this.logger.warn(`Redis counter fallback: ${this.message(error)}`);
      }
    }
    const current = Number.parseInt((await this.get(key)) ?? '0', 10) + 1;
    await this.set(key, String(current), ttlSeconds);
    return current;
  }

  private async readCounter(key: string): Promise<number> {
    const value = await this.get(key);
    const count = Number.parseInt(value ?? '0', 10);
    return Number.isFinite(count) ? count : 0;
  }

  private readLocalSet(key: string): Set<string> {
    const value = this.localValues.get(key);
    if (!value || value.expiresAt <= Date.now()) {
      return new Set();
    }
    try {
      return new Set(JSON.parse(value.value) as string[]);
    } catch {
      return new Set();
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown Redis error';
  }
}
