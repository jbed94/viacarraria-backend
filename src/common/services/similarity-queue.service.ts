import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';

import type { QueueOccupation, SubscriptionTier } from '../types.js';
import { DatabaseService } from './database.service.js';
import { RedisService } from './redis.service.js';

type QueueItem<T = any> = {
  execute: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
  enqueuedAt: number;
};

export type SimilarityQuotaConfig = {
  anonymousThroughputPerMinute: number;
  registeredThroughputPerMinute: number;
};

@Injectable()
export class SimilarityQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SimilarityQueueService.name);

  private anonymousThroughput = 30; // 30 req/min = 1 per 2000ms
  private registeredThroughput = 120; // 120 req/min = 1 per 500ms

  private readonly anonymousQueue: QueueItem[] = [];
  private readonly registeredQueue: QueueItem[] = [];

  private anonTimer: NodeJS.Timeout | null = null;
  private regTimer: NodeJS.Timeout | null = null;
  private isProcessingAnon = false;
  private isProcessingReg = false;

  private lastAnonExecution = 0;
  private lastRegExecution = 0;

  constructor(
    private readonly database: DatabaseService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadConfig();
    this.updateOccupationMetric();
  }

  onModuleDestroy(): void {
    if (this.anonTimer) clearTimeout(this.anonTimer);
    if (this.regTimer) clearTimeout(this.regTimer);
  }

  async loadConfig(): Promise<SimilarityQuotaConfig> {
    try {
      const row = await this.database.one<{ value: any }>(
        `SELECT "value" FROM "SystemSettings" WHERE "key" = 'similarityQuota'`,
      );
      if (row?.value) {
        if (typeof row.value.anonymousThroughputPerMinute === 'number') {
          this.anonymousThroughput = Math.max(
            1,
            row.value.anonymousThroughputPerMinute,
          );
        }
        if (typeof row.value.registeredThroughputPerMinute === 'number') {
          this.registeredThroughput = Math.max(
            1,
            row.value.registeredThroughputPerMinute,
          );
        }
      }
    } catch {
      // Use defaults if table is not yet initialized
    }

    return {
      anonymousThroughputPerMinute: this.anonymousThroughput,
      registeredThroughputPerMinute: this.registeredThroughput,
    };
  }

  updateConfig(config: Partial<SimilarityQuotaConfig>): void {
    if (
      config.anonymousThroughputPerMinute &&
      config.anonymousThroughputPerMinute > 0
    ) {
      this.anonymousThroughput = config.anonymousThroughputPerMinute;
    }
    if (
      config.registeredThroughputPerMinute &&
      config.registeredThroughputPerMinute > 0
    ) {
      this.registeredThroughput = config.registeredThroughputPerMinute;
    }
    this.logger.log(
      `Updated SimilarityQueue quotas: Anon = ${this.anonymousThroughput}/min, Reg = ${this.registeredThroughput}/min`,
    );
  }

  /**
   * Enqueues a Weaviate similarity search operation for the given user tier.
   * Requests are postponed in FIFO order if rate limits are exceeded, never rejected.
   */
  enqueue<T>(
    tier: SubscriptionTier | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    const isAnon = tier !== 'REGISTERED';
    const queue = isAnon ? this.anonymousQueue : this.registeredQueue;

    return new Promise<T>((resolve, reject) => {
      queue.push({
        execute: task,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });

      this.updateOccupationMetric();

      if (isAnon) {
        this.scheduleNextAnon();
      } else {
        this.scheduleNextReg();
      }
    });
  }

  private scheduleNextAnon(): void {
    if (this.isProcessingAnon || this.anonymousQueue.length === 0) return;

    const intervalMs = Math.ceil(60_000 / this.anonymousThroughput);
    const elapsed = Date.now() - this.lastAnonExecution;
    const delay = Math.max(0, intervalMs - elapsed);

    if (delay === 0) {
      void this.processAnonNext();
    } else if (!this.anonTimer) {
      this.anonTimer = setTimeout(() => {
        this.anonTimer = null;
        void this.processAnonNext();
      }, delay);
    }
  }

  private async processAnonNext(): Promise<void> {
    if (this.isProcessingAnon || this.anonymousQueue.length === 0) return;
    this.isProcessingAnon = true;

    const item = this.anonymousQueue.shift();
    this.lastAnonExecution = Date.now();
    this.updateOccupationMetric();

    if (item) {
      try {
        const result = await item.execute();
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }

    this.isProcessingAnon = false;
    this.scheduleNextAnon();
  }

  private scheduleNextReg(): void {
    if (this.isProcessingReg || this.registeredQueue.length === 0) return;

    const intervalMs = Math.ceil(60_000 / this.registeredThroughput);
    const elapsed = Date.now() - this.lastRegExecution;
    const delay = Math.max(0, intervalMs - elapsed);

    if (delay === 0) {
      void this.processRegNext();
    } else if (!this.regTimer) {
      this.regTimer = setTimeout(() => {
        this.regTimer = null;
        void this.processRegNext();
      }, delay);
    }
  }

  private async processRegNext(): Promise<void> {
    if (this.isProcessingReg || this.registeredQueue.length === 0) return;
    this.isProcessingReg = true;

    const item = this.registeredQueue.shift();
    this.lastRegExecution = Date.now();
    this.updateOccupationMetric();

    if (item) {
      try {
        const result = await item.execute();
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }

    this.isProcessingReg = false;
    this.scheduleNextReg();
  }

  getOccupation(tier?: SubscriptionTier): QueueOccupation {
    const queue =
      tier === 'REGISTERED' ? this.registeredQueue : this.anonymousQueue;
    const waiting = queue.length;
    if (waiting <= 2) return 'low';
    if (waiting <= 8) return 'mid';
    return 'high';
  }

  getSystemOccupation(): QueueOccupation {
    const totalWaiting =
      this.anonymousQueue.length + this.registeredQueue.length;
    if (totalWaiting <= 2) return 'low';
    if (totalWaiting <= 8) return 'mid';
    return 'high';
  }

  private updateOccupationMetric(): void {
    if (this.redis) {
      const level = this.getSystemOccupation();
      void this.redis.set('queue:similarity:occupation', level, 300);
    }
  }
}
