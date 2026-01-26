import {
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TokenService } from '../core/auth/services/token.service';
import { JwtPayload, JwtType } from '../core/auth/dto/jwt-payload';
import { OnModuleDestroy, Logger } from '@nestjs/common';
import { SpaceMemberRepo } from '@wiki/db/repos/space/space-member.repo';
import { SessionActivityService } from '../core/auth/services/session-activity.service';
import * as cookie from 'cookie';

@WebSocketGateway({
  cors: { origin: '*' },
  transports: ['websocket'],
})
export class WsGateway implements OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer()
  server: Server;
  private readonly logger = new Logger(WsGateway.name);
  
  constructor(
    private tokenService: TokenService,
    private spaceMemberRepo: SpaceMemberRepo,
    private sessionActivityService: SessionActivityService,
  ) {}

  async handleConnection(client: Socket, ...args: any[]): Promise<void> {
    try {
      const cookies = cookie.parse(client.handshake.headers.cookie);
      const token: JwtPayload = await this.tokenService.verifyJwt(
        cookies['authToken'],
        JwtType.ACCESS,
      );

      // Validate session exists for new tokens
      if (token.sessionId) {
        const sessionExists = await this.sessionActivityService.checkSessionExists(
          token.sessionId,
        );

        if (!sessionExists) {
          this.logger.warn(
            `WebSocket connection rejected: session not found for user ${token.sub}`,
          );
          client.emit('Unauthorized');
          client.disconnect();
          return;
        }
      }

      const userId = token.sub;
      const workspaceId = token.workspaceId;

      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);

      const workspaceRoom = `workspace-${workspaceId}`;
      const spaceRooms = userSpaceIds.map((id) => this.getSpaceRoomName(id));

      client.join([workspaceRoom, ...spaceRooms]);
      this.logger.debug(`User ${userId} connected to WebSocket`);
    } catch (err) {
      this.logger.error(`WebSocket connection error: ${err}`);
      client.emit('Unauthorized');
      client.disconnect();
    }
  }


  @SubscribeMessage('message')
  handleMessage(client: Socket, data: any): void {
    const spaceEvents = [
      'updateOne',
      'addTreeNode',
      'moveTreeNode',
      'deleteTreeNode',
    ];

    if (spaceEvents.includes(data?.operation) && data?.spaceId) {
      const room = this.getSpaceRoomName(data.spaceId);
      client.broadcast.to(room).emit('message', data);
      return;
    }

    client.broadcast.emit('message', data);
  }

  @SubscribeMessage('join-room')
  handleJoinRoom(client: Socket, @MessageBody() roomName: string): void {
    // if room is a space, check if user has permissions
    //client.join(roomName);
  }

  @SubscribeMessage('leave-room')
  handleLeaveRoom(client: Socket, @MessageBody() roomName: string): void {
    client.leave(roomName);
  }

  onModuleDestroy() {
    if (this.server) {
      this.server.close();
    }
  }

  getSpaceRoomName(spaceId: string): string {
    return `space-${spaceId}`;
  }
}
