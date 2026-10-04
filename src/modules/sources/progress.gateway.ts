import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { fromNodeHeaders } from 'better-auth/node';
import type { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';

import { auth } from '../../auth.js';
import { DatabaseService } from '../../common/services/database.service.js';
import { RedisService } from '../../common/services/redis.service.js';
import type { ViewerIdentity } from '../../common/types.js';
import type { CrawlProgressPayload } from '../search/search.dto.js';

export type ProgressPayload = {
  sourceId: string;
  graphId: string;
  nodeId: string;
  status: string;
  progress: number;
};

export type { CrawlProgressPayload };

@WebSocketGateway({
  namespace: 'ws',
  cors: { origin: true, credentials: true },
})
@Injectable()
export class ProgressGateway
  implements
    OnModuleInit,
    OnModuleDestroy,
    OnGatewayConnection,
    OnGatewayDisconnect
{
  private readonly logger = new Logger(ProgressGateway.name);
  private subscriber: Redis | null = null;

  @WebSocketServer()
  private server?: Server;

  constructor(
    private readonly redisService: RedisService,
    private readonly database: DatabaseService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const headers = { ...client.handshake.headers } as Record<string, string>;
      const authToken =
        (client.handshake.auth?.token as string | undefined) ?? '';
      if (authToken && !headers.authorization) {
        headers.authorization = `Bearer ${authToken}`;
      }
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(headers),
      });

      if (session?.user) {
        const isGuest = session.user.isAnonymous === true;
        const identity: ViewerIdentity = {
          userId: session.user.id,
          email: session.user.email,
          username: session.user.name,
          isGuest,
          tier: isGuest
            ? 'ANONYMOUS'
            : ((session.user.subscriptionTier as any) ?? 'FREE'),
        };
        client.data.identity = identity;
        if (!isGuest) {
          await client.join(`user:${identity.userId}`);
        }
        this.logger.log(
          `Authenticated WebSocket client connected: ${client.id} (user: ${identity.userId}, tier: ${identity.tier})`,
        );
      } else {
        const guestIdentity: ViewerIdentity = {
          userId: `anon-${client.id}`,
          email: null,
          username: 'Guest',
          isGuest: true,
          tier: 'ANONYMOUS',
        };
        client.data.identity = guestIdentity;
        this.logger.log(`Anonymous WebSocket client connected: ${client.id}`);
      }
    } catch (err) {
      this.logger.warn(`Failed resolving auth in WebSocket handshake: ${err}`);
      client.data.identity = {
        userId: `anon-${client.id}`,
        email: null,
        username: 'Guest',
        isGuest: true,
        tier: 'ANONYMOUS',
      };
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`WebSocket client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join:graph')
  async handleJoinGraph(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { graphId: string },
  ): Promise<{ success: boolean; graphId?: string; error?: string }> {
    if (!data?.graphId || typeof data.graphId !== 'string') {
      return { success: false, error: 'Invalid graphId' };
    }

    try {
      const graph = await this.database.one<{
        id: string;
        userId: string;
        isPublic: boolean;
      }>('SELECT "id", "userId", "isPublic" FROM "Graph" WHERE "id" = $1', [
        data.graphId,
      ]);

      if (!graph) {
        return { success: false, error: 'Graph not found' };
      }

      const identity: ViewerIdentity | undefined = client.data?.identity;
      const isOwner = identity && identity.userId === graph.userId;

      if (!graph.isPublic && !isOwner) {
        this.logger.warn(
          `Client ${client.id} (user: ${identity?.userId}) rejected joining private graph room graph:${data.graphId}`,
        );
        return {
          success: false,
          error: 'Forbidden: access to private graph room denied',
        };
      }

      await client.join(`graph:${data.graphId}`);
      this.logger.debug(
        `Client ${client.id} joined room graph:${data.graphId}`,
      );
      return { success: true, graphId: data.graphId };
    } catch (err) {
      this.logger.error(`Error joining graph room: ${err}`);
      return { success: false, error: 'Internal error joining graph room' };
    }
  }

  @SubscribeMessage('leave:graph')
  async handleLeaveGraph(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { graphId: string },
  ): Promise<{ success: boolean; graphId?: string }> {
    if (data?.graphId) {
      await client.leave(`graph:${data.graphId}`);
      this.logger.debug(`Client ${client.id} left room graph:${data.graphId}`);
    }
    return { success: true, graphId: data?.graphId };
  }

  async onModuleInit(): Promise<void> {
    try {
      this.subscriber = this.redisService.createSubscriber();
      if (this.subscriber) {
        this.subscriber.on('error', (err: Error) => {
          this.logger.warn(`Source progress subscriber error: ${err.message}`);
        });
        await this.subscriber.connect().catch((err: unknown) => {
          this.logger.warn(
            `Failed to connect progress subscriber: ${String(err)}`,
          );
        });
        await this.subscriber
          .subscribe('source:progress', 'notification:new', 'crawl:progress')
          .catch((err: unknown) => {
            this.logger.warn(
              `Failed to subscribe to progress channels: ${String(err)}`,
            );
          });
        this.subscriber.on('message', (channel: string, message: string) => {
          if (channel === 'source:progress') {
            try {
              const data = JSON.parse(message) as ProgressPayload;
              this.emitUpdate(data);
            } catch (err) {
              this.logger.warn(`Failed to parse progress message: ${err}`);
            }
          } else if (channel === 'notification:new') {
            try {
              const data = JSON.parse(message) as {
                userId: string;
                notification: unknown;
              };
              if (data?.userId && data.notification && this.server) {
                this.server
                  .to(`user:${data.userId}`)
                  .emit('notification:new', data.notification);
              }
            } catch (err) {
              this.logger.warn(`Failed to parse notification message: ${err}`);
            }
          } else if (channel === 'crawl:progress') {
            try {
              const data = JSON.parse(message) as CrawlProgressPayload;
              this.emitCrawlProgress(data);
            } catch (err) {
              this.logger.warn(
                `Failed to parse crawl:progress message: ${err}`,
              );
            }
          }
        });
        this.logger.log(
          'ProgressGateway subscribed to Redis source:progress, notification:new, and crawl:progress channels',
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to initialize Redis subscriber in ProgressGateway: ${err}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(
          'source:progress',
          'notification:new',
          'crawl:progress',
        );
        await this.subscriber.quit();
      } catch {
        // Ignored during shutdown
      }
    }
  }

  emitUpdate(payload: ProgressPayload): void {
    if (payload.graphId && this.server) {
      this.server
        .to(`graph:${payload.graphId}`)
        .emit('progress:update', payload);
    } else {
      this.server?.emit('progress:update', payload);
    }
  }

  emitCrawlProgress(payload: CrawlProgressPayload): void {
    if (payload.graphId && this.server) {
      this.server
        .to(`graph:${payload.graphId}`)
        .emit('crawl:progress', payload);
    } else {
      this.server?.emit('crawl:progress', payload);
    }
  }
}
