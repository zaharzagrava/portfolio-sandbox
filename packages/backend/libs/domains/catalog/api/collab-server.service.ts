import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { hostname } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { ApiConfigService } from '@app/common/config';
import { CollabInstanceRegistry } from '../infra/instance-registry';
import { RoomManager } from '../application/room-manager.service';
import { verifyCollabTicket } from '../infra/collab-ticket';

const PATH = /^\/collab\/([0-9a-f-]{36})$/;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_EDITORS_PER_ROOM = 50;
const PING_MS = 30_000;

/**
 * Raw `ws` on Nest's HTTP server (the y-websocket protocol is binary frames,
 * not Nest gateway JSON events). Handshake: ticket → ring ownership → room.
 * A client that reached the wrong instance (LB doesn't know the ring) gets
 * close code 4001 with the owner's URL as the reason and reconnects there.
 */
@Injectable()
export class CollabServer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CollabServer.name);
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  });
  readonly instanceId: string;
  private ping?: NodeJS.Timeout;
  private readonly alive = new WeakSet<WebSocket>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly registry: CollabInstanceRegistry,
    private readonly rooms: RoomManager,
    private readonly config: ApiConfigService,
  ) {
    this.instanceId =
      config.get('collab_instance_id') || `${hostname()}-${process.pid}`;
  }

  async onApplicationBootstrap() {
    const server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    server.on(
      'upgrade',
      (req: IncomingMessage, socket: Duplex, head: Buffer) =>
        void this.upgrade(req, socket, head),
    );
    const port = this.config.get('port');
    await this.registry.register(
      this.instanceId,
      this.config.get('collab_public_url') || `ws://localhost:${port}`,
    );

    // Dead-peer detection: a laptop that slept never sends FIN.
    this.ping = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!this.alive.has(ws)) ws.terminate();
        else {
          this.alive.delete(ws);
          ws.ping();
        }
      }
    }, PING_MS);
    this.ping.unref();
  }

  onModuleDestroy() {
    clearInterval(this.ping);
    for (const ws of this.wss.clients) ws.close(1012, 'service restart'); // clients reconnect → new owner
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://local');
    const match = PATH.exec(url.pathname);
    if (!match) return; // not ours (e.g. another upgrade handler)
    const draftId = match[1];
    const ticket = verifyCollabTicket(
      url.searchParams.get('ticket') ?? '',
      this.config.get('jwt_secret'),
    );
    if (!ticket || ticket.draftId !== draftId) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }

    this.wss.handleUpgrade(req, socket, head, async (ws) => {
      ws.binaryType = 'arraybuffer';
      this.alive.add(ws);
      ws.on('pong', () => this.alive.add(ws));
      // Clients send SyncStep1 as soon as the socket opens - before the room below is loaded. Buffer from the
      // first byte, or that message is dropped and the client never completes the sync handshake.
      const early: ArrayBuffer[] = [];
      const buffer = (data: ArrayBuffer) => early.push(data);
      ws.on('message', buffer);

      const owner = await this.registry.ownerOf(draftId);
      if (owner && owner.id !== this.instanceId)
        return ws.close(4001, owner.url);

      let room;
      try {
        room = await this.rooms.acquire(draftId);
      } catch (error) {
        this.logger.warn(
          `room ${draftId} load failed: ${(error as Error).message}`,
        );
        return ws.close(4004, 'draft not found');
      }
      if (room.members.size >= MAX_EDITORS_PER_ROOM)
        return ws.close(4008, 'room full');

      const socketAdapter = {
        send: (data: Uint8Array) =>
          ws.readyState === WebSocket.OPEN && ws.send(data),
        close: (code?: number, reason?: string) => ws.close(code, reason),
      };
      room.join(socketAdapter, ticket.userId, ticket.canWrite);
      const handle = (data: ArrayBuffer) => {
        try {
          room.handleMessage(socketAdapter, new Uint8Array(data));
        } catch (error) {
          this.logger.warn(
            `bad message in ${draftId}: ${(error as Error).message}`,
          );
          ws.close(4000, 'protocol error');
        }
      };
      ws.off('message', buffer);
      for (const data of early.splice(0)) handle(data);
      ws.on('message', handle);
      ws.on('close', () => {
        room.leave(socketAdapter);
        this.rooms.release(room);
      });
    });
  }
}
