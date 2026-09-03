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
};

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
      this.logger.log('Connected to RabbitMQ');
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
    channel.sendToQueue(
      'document_parsing_queue',
      Buffer.from(JSON.stringify(job)),
      {
        contentType: 'application/json',
        persistent: true,
        priority: job.priority,
      },
    );
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
    this.connection.on('close', () => {
      this.connection = undefined;
      this.channel = undefined;
    });
    this.channel = await this.connection.createChannel();
    await this.channel.assertQueue('document_parsing_queue', {
      durable: true,
      arguments: { 'x-max-priority': 10 },
    });
    return this.channel;
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown RabbitMQ error';
  }
}
