import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';

@WebSocketGateway({
  namespace: 'ws',
  cors: { origin: true, credentials: true },
})
export class ProgressGateway {
  @WebSocketServer()
  private server?: Server;

  emitUpdate(payload: {
    sourceId: string;
    graphId: string;
    nodeId: string;
    status: string;
    progress: number;
  }): void {
    this.server?.emit('progress:update', payload);
  }
}
