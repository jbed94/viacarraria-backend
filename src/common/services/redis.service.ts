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
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });
    this.client.on('connect', () => {
      this.available = true;
      this.logger.log('Connected to Redis');
    });
    this.client.on('ready', () => {
      this.available = true;
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

  async mget(keys: string[]): Promise<(string | null)[]> {
    if (!keys || keys.length === 0) {
      return [];
    }
    if (this.available) {
      try {
        return await this.client.mget(...keys);
      } catch (error: unknown) {
        this.available = false;
        this.logger.warn(`Redis mget fallback: ${this.message(error)}`);
      }
    }
    const now = Date.now();
    return keys.map((key) => {
      const local = this.localValues.get(key);
      if (!local || local.expiresAt <= now) {
        this.localValues.delete(key);
        return null;
      }
      return local.value;
    });
  }

  async getDailyUsage(identifier: string): Promise<number> {
    const key = `usage:${identifier}:${new Date().toISOString().slice(0, 10)}`;
    return this.readCounter(key);
  }

  async getHourlyUploadUsage(identifier: string): Promise<number> {
    const key = `uploads:${identifier}:${new Date().toISOString().slice(0, 13)}`;
    return this.readCounter(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.available) {
      try {
        if (ttlSeconds && ttlSeconds > 0) {
          await this.client.set(key, value, 'EX', ttlSeconds);
        } else {
          await this.client.set(key, value);
        }
        return;
      } catch (error: unknown) {
        this.available = false;
        this.logger.warn(`Redis write fallback: ${this.message(error)}`);
      }
    }
    this.localValues.set(key, {
      value,
      expiresAt:
        ttlSeconds && ttlSeconds > 0
          ? Date.now() + ttlSeconds * 1000
          : Number.MAX_SAFE_INTEGER,
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
        const results = await this.client
          .pipeline()
          .incr(key)
          .expire(key, ttlSeconds)
          .exec();
        if (results && results[0] && results[0][1] !== null) {
          return Number(results[0][1]);
        }
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

  createSubscriber(): Redis | null {
    if (!this.available) {
      return null;
    }
    const subscriber = this.client.duplicate({
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    subscriber.on('error', (error: Error) => {
      this.logger.warn(`Redis subscriber error: ${error.message}`);
    });
    return subscriber;
  }

  async publish(channel: string, message: string): Promise<number> {
    if (this.available) {
      try {
        return await this.client.publish(channel, message);
      } catch (error: unknown) {
        this.logger.warn(`Redis publish fallback: ${this.message(error)}`);
      }
    }
    return 0;
  }

  async del(key: string): Promise<number> {
    if (this.available) {
      try {
        return await this.client.del(key);
      } catch (error: unknown) {
        this.logger.warn(`Redis del fallback: ${this.message(error)}`);
      }
    }
    const had = this.localValues.delete(key);
    return had ? 1 : 0;
  }

  async lpush(key: string, value: string): Promise<number> {
    if (this.available) {
      try {
        return await this.client.lpush(key, value);
      } catch (error: unknown) {
        this.logger.warn(`Redis lpush fallback: ${this.message(error)}`);
      }
    }
    const existing = this.readLocalList(key);
    existing.unshift(value);
    this.localValues.set(key, {
      value: JSON.stringify(existing),
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    return existing.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<string> {
    if (this.available) {
      try {
        return await this.client.ltrim(key, start, stop);
      } catch (error: unknown) {
        this.logger.warn(`Redis ltrim fallback: ${this.message(error)}`);
      }
    }
    const existing = this.readLocalList(key);
    const end = stop < 0 ? existing.length + stop + 1 : stop + 1;
    const trimmed = existing.slice(start, end);
    this.localValues.set(key, {
      value: JSON.stringify(trimmed),
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    return 'OK';
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    if (this.available) {
      try {
        return await this.client.lrange(key, start, stop);
      } catch (error: unknown) {
        this.logger.warn(`Redis lrange fallback: ${this.message(error)}`);
      }
    }
    const existing = this.readLocalList(key);
    const end = stop < 0 ? existing.length + stop + 1 : stop + 1;
    return existing.slice(start, end);
  }

  async llen(key: string): Promise<number> {
    if (this.available) {
      try {
        return await this.client.llen(key);
      } catch (error: unknown) {
        this.logger.warn(`Redis llen fallback: ${this.message(error)}`);
      }
    }
    return this.readLocalList(key).length;
  }

  private readLocalList(key: string): string[] {
    const value = this.localValues.get(key);
    if (!value || value.expiresAt <= Date.now()) {
      return [];
    }
    try {
      const parsed = JSON.parse(value.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
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
