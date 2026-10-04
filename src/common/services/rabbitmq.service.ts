import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';

export type ParsingJob = {
  jobId: string;
  sourceId: string;
  graphId: string;
  nodeId: string;
  filePath: string;
  fileName: string;
  fileHash: string;
  priority: number;
  retryCount?: number;
  maxRetries?: number;
  storageKey?: string;
  storageUrl?: string;
};

export type TagMatchingJob = {
  jobId: string;
  sourceId: string;
  graphId: string;
  sourceName: string;
  sourceContent?: string;
  vocabItems?: Array<{ term: string; weight: number }>;
  priority?: number;
  retryCount?: number;
  maxRetries?: number;
};

export const PARSING_QUEUE = 'document_parsing_queue';
export const PARSING_DLX = 'document_parsing_dlx';
export const PARSING_DLQ = 'document_parsing_dlq';

export const TAG_MATCHING_QUEUE = 'tag_matching_queue';
export const TAG_MATCHING_DLX = 'tag_matching_dlx';
export const TAG_MATCHING_DLQ = 'tag_matching_dlq';

@Injectable()
export class RabbitMqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private readonly url: string;
  private connection?: ChannelModel;
  private channel?: Channel;

  constructor(config: ConfigService) {
    this.url = config.getOrThrow<string>('RABBITMQ_URL');
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureChannel();
      this.logger.log('Connected to RabbitMQ with DLQ support');
    } catch (error: unknown) {
      this.logger.warn(
        `RabbitMQ deferred until available: ${this.message(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }

  async publishParsingJob(job: ParsingJob): Promise<void> {
    const channel = await this.ensureChannel();
    const payload: ParsingJob = {
      ...job,
      retryCount: job.retryCount ?? 0,
      maxRetries: job.maxRetries ?? 3,
    };
    channel.sendToQueue(PARSING_QUEUE, Buffer.from(JSON.stringify(payload)), {
      contentType: 'application/json',
      persistent: true,
      priority: job.priority,
    });
  }

  async publishTagMatchingJob(job: TagMatchingJob): Promise<void> {
    const channel = await this.ensureChannel();
    const payload: TagMatchingJob = {
      ...job,
      priority: job.priority ?? 5,
      retryCount: job.retryCount ?? 0,
      maxRetries: job.maxRetries ?? 3,
    };
    channel.sendToQueue(
      TAG_MATCHING_QUEUE,
      Buffer.from(JSON.stringify(payload)),
      {
        contentType: 'application/json',
        persistent: true,
        priority: payload.priority,
      },
    );
  }

  async publishToDlq(
    job: ParsingJob,
    reason: string,
    errorType: 'transient_exhausted' | 'fatal' = 'fatal',
  ): Promise<void> {
    const channel = await this.ensureChannel();
    const payload = {
      ...job,
      failureReason: reason,
      failureType: errorType,
      failedAt: Date.now(),
    };
    channel.sendToQueue(PARSING_DLQ, Buffer.from(JSON.stringify(payload)), {
      contentType: 'application/json',
      persistent: true,
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureChannel();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureChannel(): Promise<Channel> {
    if (this.channel) {
      return this.channel;
    }
    this.connection = await amqp.connect(this.url);
    this.connection.on('error', (err: Error) => {
      this.logger.warn(`RabbitMQ connection error: ${err.message}`);
    });
    this.connection.on('close', () => {
      this.connection = undefined;
      this.channel = undefined;
    });
    this.channel = await this.connection.createChannel();
    this.channel.on('error', (err: Error) => {
      this.logger.warn(`RabbitMQ channel error: ${err.message}`);
    });

    // 1. Assert Dead Letter Exchange (direct)
    await this.channel.assertExchange(PARSING_DLX, 'direct', { durable: true });

    // 2. Assert Dead Letter Queue
    await this.channel.assertQueue(PARSING_DLQ, { durable: true });

    // 3. Bind Dead Letter Queue to Dead Letter Exchange
    await this.channel.bindQueue(PARSING_DLQ, PARSING_DLX, PARSING_DLQ);

    // 4. Assert primary work queue with dead letter exchange routing arguments
    const queueArgs = {
      'x-max-priority': 10,
      'x-dead-letter-exchange': PARSING_DLX,
      'x-dead-letter-routing-key': PARSING_DLQ,
    };

    try {
      await this.channel.assertQueue(PARSING_QUEUE, {
        durable: true,
        arguments: queueArgs,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('PRECONDITION_FAILED')) {
        this.logger.warn(
          'Existing queue arguments differ; updating queue with DLX bindings...',
        );
        this.channel = await this.connection.createChannel();
        await this.channel.deleteQueue(PARSING_QUEUE);
        await this.channel.assertQueue(PARSING_QUEUE, {
          durable: true,
          arguments: queueArgs,
        });
      } else {
        throw err;
      }
    }

    // 5. Assert Tag Matching Dead Letter Exchange and Queue
    await this.channel.assertExchange(TAG_MATCHING_DLX, 'direct', {
      durable: true,
    });
    await this.channel.assertQueue(TAG_MATCHING_DLQ, { durable: true });
    await this.channel.bindQueue(
      TAG_MATCHING_DLQ,
      TAG_MATCHING_DLX,
      TAG_MATCHING_DLQ,
    );

    const tagQueueArgs = {
      'x-max-priority': 10,
      'x-dead-letter-exchange': TAG_MATCHING_DLX,
      'x-dead-letter-routing-key': TAG_MATCHING_DLQ,
    };

    try {
      await this.channel.assertQueue(TAG_MATCHING_QUEUE, {
        durable: true,
        arguments: tagQueueArgs,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('PRECONDITION_FAILED')) {
        this.logger.warn(
          'Existing tag queue arguments differ; updating queue with DLX bindings...',
        );
        this.channel = await this.connection.createChannel();
        await this.channel.deleteQueue(TAG_MATCHING_QUEUE);
        await this.channel.assertQueue(TAG_MATCHING_QUEUE, {
          durable: true,
          arguments: tagQueueArgs,
        });
      } else {
        throw err;
      }
    }

    return this.channel;
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown RabbitMQ error';
  }
}
