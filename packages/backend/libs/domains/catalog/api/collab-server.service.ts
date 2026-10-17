import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { hostname } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ReadinessService } from '@app/infrastructure/health';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { DraftTicketService } from '../application/draft-ticket.service';
import { collabCloseCounter } from '../application/draft-metrics';
import { RoomManager } from '../application/room-manager.service';
import { CLOSE, type CloseReason } from '../domain/close-codes';
import {
  COLLAB_TIMINGS,
  DEFAULT_COLLAB_TIMINGS,
  DRAFT_LIMITS,
  type CollabTimings,
} from '../domain/draft-limits';
import {
  DRAFT_MEMBERSHIP,
  DRAFT_REPOSITORY,
  RING_REGISTRY,
  type DraftRepository,
  type MembershipReader,
  type RingRegistry,
} from '../domain/draft-ports';
import type { Ability } from '../domain/frame-policy';
import { CollabOrigin } from './collab-origin';
import type { TicketClaims } from '../application/draft-ticket.service';
import { DraftNotFoundError } from '../domain/draft-errors';

const PATH =
  /^\/collab\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

type Decision =
  | { kind: 'redirect'; url: string }
  | { kind: 'missing' }
  | { kind: 'revoked'; close: CloseReason }
  | { kind: 'join'; ability: Ability };

/**
 * Raw `ws` on Nest's HTTP server (the y-websocket protocol is binary frames, not Nest gateway JSON events).
 * Handshake order (contracts/collab-ws.md): ticket (no consumption) -> Origin -> ownership (4001, ticket kept) -> draft
 * re-read (4004) and a fresh membership read -> consume the ticket id -> join the room, early frames buffered in order.
 * Nothing in a log line carries the ticket: only ids of the connection, draft, shop and user.
 */
@Injectable()
export class CollabServer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CollabServer.name);
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: DRAFT_LIMITS.frameBytes,
  });
  readonly instanceId: string;
  private ping?: NodeJS.Timeout;
  private readonly alive = new WeakSet<WebSocket>();
  private readonly timings: CollabTimings;
  private registered: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly rooms: RoomManager,
    private readonly tickets: DraftTicketService,
    private readonly origins: CollabOrigin,
    private readonly config: ApiConfigService,
    @Inject(RING_REGISTRY) private readonly ring: RingRegistry,
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(DRAFT_MEMBERSHIP) private readonly membership: MembershipReader,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(COLLAB_TIMINGS) timings?: CollabTimings,
    @Optional() private readonly shutdown?: ShutdownRegistry,
    @Optional() private readonly readiness?: ReadinessService,
  ) {
    this.timings = { ...DEFAULT_COLLAB_TIMINGS, ...timings };
    this.instanceId =
      config.get('collab_instance_id') || `${hostname()}-${process.pid}`;
    this.rooms.bindSelf(this.instanceId);
  }

  onApplicationBootstrap() {
    const server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    server.on(
      'upgrade',
      (req: IncomingMessage, socket: Duplex, head: Buffer) =>
        void this.upgrade(req, socket, head),
    );
    // The public URL is known once the server listens (tests listen on port 0).
    const announce = () => {
      const address = server.address() as AddressInfo | null;
      const url =
        this.config.get('collab_public_url') ||
        `ws://127.0.0.1:${address?.port ?? this.config.get('port')}`;
      this.registered = this.ring
        .register({ id: this.instanceId, url })
        .catch((error: Error) =>
          this.logger.error({
            msg: 'ring registration failed',
            error: error.name,
          }),
        );
    };
    if (server.listening) announce();
    else server.once('listening', announce);

    this.readiness?.register({
      name: 'collab-ring',
      scope: 'pod',
      check: () =>
        this.ring.registered()
          ? Promise.resolve()
          : Promise.reject(new Error('not in the ring')),
    });
    // Shutdown order: readiness is flipped by the platform first, then this instance leaves the ring, then rooms flush, then sockets close.
    this.shutdown?.register({
      name: 'collab.ring.leave',
      order: 10,
      phase: 'drain',
      run: () => this.ring.leave(),
    });
    this.shutdown?.register({
      name: 'collab.rooms.drain',
      order: 30,
      phase: 'drain',
      run: () => this.rooms.drain(CLOSE.serviceRestart),
    });

    // Dead-peer detection: a laptop that slept never sends FIN. One missed answer terminates the connection.
    this.ping = setInterval(() => this.pingSweep(), this.timings.pingMs);
    this.ping.unref();
  }

  /** One liveness round: connections that did not answer the last ping are terminated, the others are pinged again. */
  pingSweep(): void {
    for (const ws of this.wss.clients) {
      if (!this.alive.has(ws)) ws.terminate();
      else {
        this.alive.delete(ws);
        ws.ping();
      }
    }
  }

  /** Resolves once this instance is in the ring (specs wait for it). */
  whenRegistered(): Promise<void> {
    return this.registered;
  }

  onModuleDestroy() {
    clearInterval(this.ping);
    for (const ws of this.wss.clients) ws.terminate();
  }

  private refuse(socket: Duplex, status: string) {
    socket.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      await this.upgradeInner(req, socket, head);
    } catch (error) {
      this.logger.error({
        msg: 'upgrade failed',
        event: 'upgrade_failed',
        error: (error as Error).name,
      });
      this.refuse(socket, '500 Internal Server Error');
    }
  }

  private async upgradeInner(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) {
    const url = new URL(req.url ?? '/', 'http://local');
    const match = PATH.exec(url.pathname);
    if (!match) return; // not ours (another upgrade handler)
    const draftId = match[1].toLowerCase();
    socket.on('error', () => undefined);

    // 1. Ticket: signature and claims, no consumption.
    const ticket = this.tickets.verify(
      url.searchParams.get('ticket') ?? '',
      draftId,
    );
    if (!ticket) {
      this.log('handshake refused', {
        event: 'handshake_refused',
        reason: 'ticket',
        draftId,
      });
      return this.refuse(socket, '401 Unauthorized');
    }
    // Origin.
    if (!this.origins.isAllowed(req.headers.origin)) {
      this.log('handshake refused', {
        event: 'handshake_refused',
        reason: 'origin',
        draftId,
        shopId: ticket.shopId,
        userId: ticket.userId,
      });
      return this.refuse(socket, '403 Forbidden');
    }

    let decision: Decision;
    try {
      decision = await this.decide(ticket);
      if (decision.kind === 'join') {
        // 4. Consume the ticket id. A replay is refused before the upgrade completes.
        if (!(await this.tickets.consume(ticket.jti))) {
          this.log('handshake refused', {
            event: 'handshake_refused',
            reason: 'replay',
            draftId,
            shopId: ticket.shopId,
            userId: ticket.userId,
          });
          return this.refuse(socket, '401 Unauthorized');
        }
      }
    } catch (error) {
      this.log('handshake failed', {
        event: 'handshake_failed',
        draftId,
        error: (error as Error).name,
      });
      return this.refuse(socket, '503 Service Unavailable');
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.binaryType = 'arraybuffer';
      // Clients send sync step 1 as soon as the socket opens, before the room is loaded: buffer from the first byte.
      const early: ArrayBuffer[] = [];
      const buffer = (data: ArrayBuffer) => early.push(data);
      ws.on('message', buffer);
      ws.on('error', () => undefined);
      this.alive.add(ws);
      ws.on('pong', () => this.alive.add(ws));

      const close = (c: CloseReason, text?: string) => {
        collabCloseCounter.add(1, { code: `${c.code}` });
        ws.close(c.code, text ?? c.reason);
      };
      if (decision.kind === 'redirect')
        return close(CLOSE.wrongInstance, decision.url);
      if (decision.kind === 'missing') return close(CLOSE.draftNotFound);
      if (decision.kind === 'revoked') return close(decision.close);
      void this.join(ws, ticket, decision.ability, early, buffer, close);
    });
  }

  /** Steps 2 and 3 plus the membership read; none of them consumes the ticket. */
  private async decide(ticket: TicketClaims): Promise<Decision> {
    const owner = await this.ring.ownerOf(ticket.draftId);
    if (!owner) throw new Error('no editing instance in the ring');
    if (owner.id !== this.instanceId)
      return { kind: 'redirect', url: owner.url };

    const draft = await this.drafts.findInShop(ticket.shopId, ticket.draftId);
    if (!draft) return { kind: 'missing' };

    const access = await this.membership.accessOf(ticket.shopId, ticket.userId);
    if (access.kind === 'none')
      return { kind: 'revoked', close: CLOSE.accessRevoked };
    if (access.kind === 'inactive')
      return { kind: 'revoked', close: CLOSE.shopInactive };
    const ability: Ability =
      ticket.canWrite && access.ability === 'write' && draft.status === 'DRAFT'
        ? 'write'
        : 'read';
    return { kind: 'join', ability };
  }

  private async join(
    ws: WebSocket,
    ticket: TicketClaims,
    ability: Ability,
    early: ArrayBuffer[],
    buffer: (data: ArrayBuffer) => number,
    close: (c: CloseReason, text?: string) => void,
  ) {
    let room;
    try {
      room = await this.rooms.acquire(ticket.shopId, ticket.draftId);
    } catch (error) {
      if (error instanceof DraftNotFoundError)
        return close(CLOSE.draftNotFound);
      this.log('room load failed', {
        event: 'room_load_failed',
        draftId: ticket.draftId,
        shopId: ticket.shopId,
        error: (error as Error).name,
      });
      return close(CLOSE.storeUnavailable);
    }
    const adapter = {
      send: (data: Uint8Array) =>
        ws.readyState === WebSocket.OPEN && ws.send(data),
      close: (code: number, reason: string) => ws.close(code, reason),
    };
    const joined = room.join(adapter, ticket.userId, ability);
    if (!joined.ok) {
      this.rooms.release(room);
      return close(joined.close);
    }
    this.rooms.connectionsChanged();
    this.log('joined', {
      event: 'joined',
      ...room.idForLog(adapter),
      draftId: ticket.draftId,
      shopId: ticket.shopId,
      ability,
    });

    const handle = (data: ArrayBuffer) => {
      try {
        room.handleMessage(adapter, new Uint8Array(data));
      } catch (error) {
        this.log('bad message', {
          event: 'protocol_error',
          ...room.idForLog(adapter),
          draftId: ticket.draftId,
          error: (error as Error).name,
        });
        close(CLOSE.protocolError);
      }
    };
    ws.off('message', buffer);
    for (const data of early.splice(0)) handle(data);
    ws.on('message', handle);
    ws.on('close', () => {
      room.leave(adapter);
      this.rooms.release(room);
    });
  }

  /** Structured line: ids of the connection, draft, shop and user; never a ticket, a url or document content. */
  private log(msg: string, fields: Record<string, unknown>) {
    this.logger.log({ msg, ...fields });
  }
}
