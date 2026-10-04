import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';

import {
  PARSING_DLQ,
  PARSING_DLX,
  PARSING_QUEUE,
  ParsingJob,
  RabbitMqService,
  TAG_MATCHING_DLQ,
  TAG_MATCHING_DLX,
  TAG_MATCHING_QUEUE,
  TagMatchingJob,
} from './rabbitmq.service.js';

jest.mock('amqplib');

describe('RabbitMqService', () => {
  let service: RabbitMqService;
  let mockChannel: any;
  let mockConnection: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockChannel = {
      assertExchange: jest.fn().mockResolvedValue({ exchange: PARSING_DLX }),
      assertQueue: jest.fn().mockResolvedValue({ queue: PARSING_QUEUE }),
      bindQueue: jest.fn().mockResolvedValue({}),
      deleteQueue: jest.fn().mockResolvedValue({ messageCount: 0 }),
      sendToQueue: jest.fn().mockReturnValue(true),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };

    mockConnection = {
      createChannel: jest.fn().mockResolvedValue(mockChannel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };

    (amqp.connect as jest.Mock).mockResolvedValue(mockConnection);

    const config = {
      getOrThrow: jest.fn().mockReturnValue('amqp://localhost:5672'),
    } as unknown as ConfigService;

    service = new RabbitMqService(config);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('declares DLX, DLQ, binds them, and asserts main parsing queue with DLX arguments', async () => {
    await service.onModuleInit();

    expect(amqp.connect).toHaveBeenCalledWith('amqp://localhost:5672');
    expect(mockConnection.createChannel).toHaveBeenCalled();

    // 1. Assert DLX
    expect(mockChannel.assertExchange).toHaveBeenCalledWith(
      PARSING_DLX,
      'direct',
      { durable: true },
    );

    // 2. Assert DLQ
    expect(mockChannel.assertQueue).toHaveBeenCalledWith(PARSING_DLQ, {
      durable: true,
    });

    // 3. Bind DLQ to DLX
    expect(mockChannel.bindQueue).toHaveBeenCalledWith(
      PARSING_DLQ,
      PARSING_DLX,
      PARSING_DLQ,
    );

    // 4. Assert primary work queue with dead letter exchange arguments
    expect(mockChannel.assertQueue).toHaveBeenCalledWith(PARSING_QUEUE, {
      durable: true,
      arguments: {
        'x-max-priority': 10,
        'x-dead-letter-exchange': PARSING_DLX,
        'x-dead-letter-routing-key': PARSING_DLQ,
      },
    });

    // 5. Assert Tag Matching DLX & DLQ
    expect(mockChannel.assertExchange).toHaveBeenCalledWith(
      TAG_MATCHING_DLX,
      'direct',
      { durable: true },
    );
    expect(mockChannel.assertQueue).toHaveBeenCalledWith(TAG_MATCHING_DLQ, {
      durable: true,
    });
    expect(mockChannel.bindQueue).toHaveBeenCalledWith(
      TAG_MATCHING_DLQ,
      TAG_MATCHING_DLX,
      TAG_MATCHING_DLQ,
    );
    expect(mockChannel.assertQueue).toHaveBeenCalledWith(TAG_MATCHING_QUEUE, {
      durable: true,
      arguments: {
        'x-max-priority': 10,
        'x-dead-letter-exchange': TAG_MATCHING_DLX,
        'x-dead-letter-routing-key': TAG_MATCHING_DLQ,
      },
    });
  });

  it('publishes parsing job with default retryCount and maxRetries metadata', async () => {
    const job: ParsingJob = {
      jobId: 'job-123',
      sourceId: 'src-123',
      graphId: 'graph-123',
      nodeId: 'node-123',
      filePath: 's3://bucket/key.pdf',
      fileName: 'key.pdf',
      fileHash: 'sha256hash',
      priority: 5,
    };

    await service.publishParsingJob(job);

    expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
      PARSING_QUEUE,
      expect.any(Buffer),
      {
        contentType: 'application/json',
        persistent: true,
        priority: 5,
      },
    );

    const sentPayload = JSON.parse(
      mockChannel.sendToQueue.mock.calls[0][1].toString(),
    );
    expect(sentPayload.jobId).toBe('job-123');
    expect(sentPayload.retryCount).toBe(0);
    expect(sentPayload.maxRetries).toBe(3);
  });

  it('publishes dead letter jobs to PARSING_DLQ', async () => {
    const job: ParsingJob = {
      jobId: 'job-dead',
      sourceId: 'src-dead',
      graphId: 'graph-dead',
      nodeId: 'node-dead',
      filePath: 's3://bucket/corrupt.pdf',
      fileName: 'corrupt.pdf',
      fileHash: 'corrupthash',
      priority: 1,
      retryCount: 3,
      maxRetries: 3,
    };

    await service.publishToDlq(
      job,
      'Corrupt PDF binary stream',
      'transient_exhausted',
    );

    expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
      PARSING_DLQ,
      expect.any(Buffer),
      {
        contentType: 'application/json',
        persistent: true,
      },
    );

    const sentPayload = JSON.parse(
      mockChannel.sendToQueue.mock.calls[0][1].toString(),
    );
    expect(sentPayload.jobId).toBe('job-dead');
    expect(sentPayload.failureReason).toBe('Corrupt PDF binary stream');
    expect(sentPayload.failureType).toBe('transient_exhausted');
    expect(sentPayload.failedAt).toBeDefined();
  });

  it('re-asserts queue with DLX when encountering PRECONDITION_FAILED on legacy queue', async () => {
    // Simulate first call to assertQueue for PARSING_QUEUE failing with PRECONDITION_FAILED
    let callCount = 0;
    mockChannel.assertQueue.mockImplementation(
      (queueName: string, options?: any) => {
        if (queueName === PARSING_QUEUE && callCount === 0) {
          callCount++;
          const err = new Error(
            "PRECONDITION_FAILED - inequivalent arg 'x-dead-letter-exchange'",
          );
          throw err;
        }
        return Promise.resolve({ queue: queueName });
      },
    );

    await service.onModuleInit();

    expect(mockChannel.deleteQueue).toHaveBeenCalledWith(PARSING_QUEUE);
    expect(mockChannel.assertQueue).toHaveBeenCalledTimes(5); // 1. DLQ, 2. failed main, 3. recreated main, 4. Tag DLQ, 5. Tag Queue
  });

  it('publishes tag matching job with default priority and retries metadata', async () => {
    const job: TagMatchingJob = {
      jobId: 'tag-job-123',
      sourceId: 'src-123',
      graphId: 'graph-123',
      sourceName: 'Architecture Overview',
      sourceContent: 'System architecture with distributed message queues',
      vocabItems: [
        { term: 'queue', weight: 1.0 },
        { term: 'distributed', weight: 0.8 },
      ],
      priority: 7,
    };

    await service.publishTagMatchingJob(job);

    expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
      TAG_MATCHING_QUEUE,
      expect.any(Buffer),
      {
        contentType: 'application/json',
        persistent: true,
        priority: 7,
      },
    );

    const sentPayload = JSON.parse(
      mockChannel.sendToQueue.mock.calls[0][1].toString(),
    );
    expect(sentPayload.jobId).toBe('tag-job-123');
    expect(sentPayload.sourceId).toBe('src-123');
    expect(sentPayload.retryCount).toBe(0);
    expect(sentPayload.maxRetries).toBe(3);
    expect(sentPayload.priority).toBe(7);
  });
});
