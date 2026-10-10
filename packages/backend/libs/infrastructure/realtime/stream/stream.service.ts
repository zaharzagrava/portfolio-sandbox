import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { streamQuerySchema } from '@marketplace-sandbox/contracts';
import type { Request, Response } from 'express';
import { CLOCK, Clock } from '@app/common/core/clock';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { RealtimeConfig } from '../config/realtime.config';
import {
  HEARTBEAT_FRAME,
  formatBaseline,
  formatFrame,
  formatResync,
  formatRetry,
  formatRevoked,
} from '../frame';
import {
  SubscriptionHub,
  type RevocationNotice,
} from '../hub/subscription-hub';
import { streamKey } from '../keys';
import {
  RealtimeMetrics,
  type ClosedReason,
  type RefusedReason,
} from '../metrics/realtime-metrics';
import { TopicRegistry } from '../topic-registry';
import {
  LIVE_ONLY_ID,
  comparePositions,
  decideReplay,
  decodeCursor,
  encodeCursor,
  parseTopicShape,
  retryDelayMs,
  type RealtimeMessage,
} from '../topics';
import { StreamConnection } from './connection';
import {
  StreamCapacityError,
  StreamForbiddenError,
  StreamInvalidQueryError,
  StreamInvalidTopicsError,
  StreamPolicyUnavailableError,
  StreamTooManyConnectionsError,
  StreamUnauthenticatedError,
  StreamUnavailableError,
} from './stream-errors';
import { STREAM_PRINCIPAL } from './stream-auth.guard';
import {
  StreamAuthenticatorRegistry,
  StreamInvalidCredentialError,
  type StreamPrincipal,
} from './stream-authenticator';

const refusalOf = (error: unknown): RefusedReason =>
  error instanceof StreamInvalidTopicsError ||
  error instanceof StreamInvalidQueryError
    ? 'invalid'
    : error instanceof StreamUnauthenticatedError
      ? 'unauthenticated'
      : error instanceof StreamForbiddenError
        ? 'forbidden'
        : error instanceof StreamTooManyConnectionsError
          ? 'too_many'
          : error instanceof StreamCapacityError
            ? 'capacity'
            : error instanceof StreamPolicyUnavailableError
              ? 'policy_unavailable'
              : 'unavailable';

interface StreamInfo {
  exists: boolean;
  latestId: string;
  maxDeletedId: string;
}

/**
 * The stream endpoint's engine (S51). Order of a request: validate the query, authenticate, reserve a slot, run every
 * topic's rule, subscribe to the backplane, then start the response. Resuming subscribes first and buffers live messages
 * (bounded), pages the replay buffer to its end, then flushes the buffer skipping what was replayed: no gap, no duplicate.
 * Every structure is released by one idempotent `close`, whoever calls it.
 */
@Injectable()
export class StreamService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamService.name);
  private readonly connections = new Set<StreamConnection>();
  private readonly perUser = new Map<string, number>();
  private readonly perAddress = new Map<string, number>();
  private nextId = 1;
  private controlReady?: Promise<void>;
  private resubscribeOff?: () => void;

  constructor(
    private readonly registry: TopicRegistry,
    private readonly authenticator: StreamAuthenticatorRegistry,
    private readonly hub: SubscriptionHub,
    private readonly redis: RedisService,
    private readonly config: RealtimeConfig,
    private readonly metrics: RealtimeMetrics,
    @Optional() @Inject(CLOCK) private readonly clock?: Clock,
  ) {}

  private now(): number {
    return this.clock ? this.clock.now().getTime() : Date.now();
  }

  /** Throws the problem for a request that cannot be served; otherwise takes over the response until it closes. */
  async open(
    req: Request,
    res: Response,
    query: Record<string, unknown>,
    lastEventId: string | undefined,
  ): Promise<void> {
    try {
      const topics = this.parseQuery(query);
      const principal = await this.authenticate(req);
      const conn = this.admit(req, res, principal, topics);
      try {
        await this.serve(conn, res, topics, lastEventId);
      } catch (error) {
        if (!conn.headersSent) conn.close('refused');
        else conn.close('error');
        throw error;
      }
    } catch (error) {
      if (res.headersSent) {
        this.logger.warn(`realtime stream failed: ${(error as Error).message}`);
        return;
      }
      this.metrics.refused.add(1, { reason: refusalOf(error) });
      throw error;
    }
  }

  private parseQuery(query: Record<string, unknown>): string[] {
    if (Object.keys(query).some((key) => key !== 'topics'))
      throw new StreamInvalidQueryError();
    const parsed = streamQuerySchema.safeParse(query);
    if (!parsed.success) throw new StreamInvalidTopicsError();
    const topics = parsed.data.topics;
    if (
      topics.length > this.config.get('maxTopicsPerConnection') ||
      !topics.every((t) => this.registry.isKnown(t))
    )
      throw new StreamInvalidTopicsError();
    return topics;
  }

  private async authenticate(req: Request): Promise<StreamPrincipal | null> {
    const resolved = (req as unknown as Record<symbol, StreamPrincipal | null>)[
      STREAM_PRINCIPAL
    ];
    if (resolved !== undefined) return resolved;
    try {
      return await this.authenticator.authenticate(req);
    } catch (error) {
      if (error instanceof StreamInvalidCredentialError)
        throw new StreamUnauthenticatedError();
      throw error;
    }
  }

  /** Checks the caps and registers the connection (and its counters) before anything is awaited again. */
  private admit(
    req: Request,
    res: Response,
    principal: StreamPrincipal | null,
    topics: string[],
  ): StreamConnection {
    if (this.connections.size >= this.config.get('instanceCapacity')) {
      throw new StreamCapacityError(1 + Math.floor(Math.random() * 5));
    }
    // The platform's resolved client address (trusted-proxy aware), never a raw forwarding header.
    const address =
      (req as Request & { clientIp?: string }).clientIp ??
      req.socket.remoteAddress ??
      'unknown';
    const userId = principal?.userId;
    const counter = userId ? this.perUser : this.perAddress;
    const key = userId ?? address;
    const limit = userId
      ? this.config.get('maxConnectionsPerUser')
      : this.config.get('maxConnectionsPerAddress');
    if ((counter.get(key) ?? 0) >= limit) {
      throw new StreamTooManyConnectionsError();
    }
    counter.set(key, (counter.get(key) ?? 0) + 1);

    const conn = new StreamConnection(
      this.nextId++,
      { userId, roles: principal?.roles ?? [], address },
      res,
      this.config.values,
      (reason) => this.onClosed(conn, reason, counter, key),
    );
    for (const topic of topics) conn.topics.set(topic, { state: 'admitting' });
    this.connections.add(conn);
    this.metrics.connections.set(this.connections.size);
    // First thing after registering: whoever closes the socket, the connection is released (also mid-connect).
    res.on('close', () => conn.close('client'));
    return conn;
  }

  private onClosed(
    conn: StreamConnection,
    reason: ClosedReason | 'refused',
    counter: Map<string, number>,
    key: string,
  ) {
    this.connections.delete(conn);
    const left = (counter.get(key) ?? 1) - 1;
    if (left <= 0) counter.delete(key);
    else counter.set(key, left);
    this.metrics.connections.set(this.connections.size);
    if (reason !== 'refused') {
      this.metrics.closed.add(1, { reason });
      this.logger.log(
        `realtime stream closed reason=${reason} events=${conn.delivered} durationMs=${Date.now() - conn.openedAt}`,
      );
    }
  }

  private async serve(
    conn: StreamConnection,
    res: Response,
    topics: string[],
    lastEventId: string | undefined,
  ): Promise<void> {
    await this.ensureControl();
    if (conn.closed) return;

    await this.authorize(conn, topics);
    if (conn.closed) return;

    await this.subscribeAll(conn, topics);
    if (conn.closed) return;

    const { cursor, ignored } = decodeCursor(lastEventId, {
      isRequested: (t) => conn.topics.has(t),
      now: this.now(),
    });
    if (ignored) this.metrics.cursorIgnored.add(ignored);
    for (const [topic, position] of cursor) conn.cursor.set(topic, position);

    // First connect for a topic: its baseline is the topic's latest stored position, no history (FR-006).
    const baselined: string[] = [];
    try {
      await Promise.all(
        topics
          .filter((t) => !conn.cursor.has(t))
          .map(async (topic) => {
            const info = await this.readInfo(topic);
            if (info.exists) {
              conn.cursor.set(topic, info.latestId);
              baselined.push(topic);
            }
          }),
      );
    } catch {
      throw new StreamUnavailableError();
    }
    if (conn.closed) return;

    for (const state of conn.topics.values())
      if (state.state === 'admitting') state.state = 'active';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies (nginx/ALB-adjacent) must not buffer the stream.
      'X-Accel-Buffering': 'no',
    });
    conn.headersSent = true;
    res.flushHeaders();
    conn.write(
      formatRetry(
        retryDelayMs(
          Math.random(),
          this.config.get('retryMinMs'),
          this.config.get('retryMaxMs'),
        ),
      ),
    );
    if (baselined.length) conn.write(formatBaseline(encodeCursor(conn.cursor)));
    conn.startHeartbeat(HEARTBEAT_FRAME);

    // A revocation that arrived while the connection was being admitted applies now (FR-040).
    for (const [topic, state] of [...conn.topics])
      if (state.state === 'revoked') this.finishRevocation(conn, topic);
    if (conn.closed) return;

    await this.catchUp(conn);
  }

  /** Every requested topic's rule runs once, in parallel, with a timeout: a fault is 503, never 403 and never admission. */
  private async authorize(conn: StreamConnection, topics: string[]) {
    const viewer = { userId: conn.userId, roles: conn.principal.roles };
    const outcomes = await Promise.all(
      topics.map(async (topic): Promise<'allow' | 'deny' | 'fault'> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('rule timed out')),
              this.config.get('ruleTimeoutMs'),
            );
          });
          const allowed = await Promise.race([
            this.registry.canSubscribe(viewer, topic),
            timeout,
          ]);
          return allowed ? 'allow' : 'deny';
        } catch (error) {
          this.logger.warn(
            `realtime rule failed route=${this.registry.resolve(topic)?.key}: ${(error as Error).message}`,
          );
          return 'fault';
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    if (conn.closed) return;
    if (outcomes.includes('fault')) {
      throw new StreamPolicyUnavailableError();
    }
    if (outcomes.includes('deny')) {
      if (conn.userId) {
        throw new StreamForbiddenError();
      }
      throw new StreamUnauthenticatedError();
    }
  }

  private async subscribeAll(conn: StreamConnection, topics: string[]) {
    const results = await Promise.allSettled(
      topics.map(async (topic) => {
        const release = await this.hub.subscribe(topic, (message) =>
          this.onLive(conn, message),
        );
        const entry = conn.topics.get(topic)!;
        entry.release = release;
        // The client may have left while the subscribe was pending: nothing may stay behind.
        if (conn.closed) await release();
      }),
    );
    if (results.some((r) => r.status === 'rejected')) {
      const failed = results.find((r) => r.status === 'rejected');
      this.logger.warn(
        `realtime subscribe failed: ${((failed as PromiseRejectedResult).reason as Error)?.message}`,
      );
      throw new StreamUnavailableError();
    }
  }

  private ensureControl(): Promise<void> {
    this.controlReady ??= this.hub
      .onControl((notice) => this.applyRevocation(notice))
      .then(() => {
        this.resubscribeOff ??= this.hub.onResubscribed(() => this.gapFill());
      })
      .catch((error) => {
        this.controlReady = undefined;
        this.logger.warn(
          `realtime control channel: ${(error as Error).message}`,
        );
        throw new StreamUnavailableError();
      });
    return this.controlReady;
  }

  // ---- live path ----------------------------------------------------------------------------------------------

  private onLive(conn: StreamConnection, message: RealtimeMessage) {
    if (conn.closed) return;
    const topic = conn.topics.get(message.topic);
    if (!topic || topic.state === 'revoked') return;
    if (conn.replaying) {
      if (conn.buffered.length >= this.config.get('replayBuffer')) {
        // Discard the backlog and read it from the store instead: replayable events are there (FR-032).
        conn.buffered = [];
        conn.needsAnotherPass = true;
        this.metrics.replayOverflow.add(1);
      } else conn.buffered.push(message);
      return;
    }
    this.send(conn, message, 'live');
  }

  private send(
    conn: StreamConnection,
    message: RealtimeMessage,
    origin: 'live' | 'replayed',
  ) {
    if (conn.closed) return;
    const topic = conn.topics.get(message.topic);
    if (!topic || topic.state !== 'active') return;
    let frame: string | null;
    let kind: 'replayable' | 'live_only' | 'replayed';
    if (message.id === LIVE_ONLY_ID) {
      frame = formatFrame({
        type: message.type,
        topic: message.topic,
        data: message.data,
      });
      kind = 'live_only';
    } else {
      const last = conn.cursor.get(message.topic);
      if (last && comparePositions(message.id, last) <= 0) return;
      conn.cursor.set(message.topic, message.id);
      frame = formatFrame({
        cursor: encodeCursor(conn.cursor),
        type: message.type,
        topic: message.topic,
        data: message.data,
      });
      kind = origin === 'replayed' ? 'replayed' : 'replayable';
    }
    if (frame === null) {
      this.logger.warn('realtime event with an unwritable type skipped');
      return;
    }
    if (!conn.write(frame)) return;
    conn.delivered++;
    this.metrics.delivered.add(1, { kind });
  }

  // ---- replay -------------------------------------------------------------------------------------------------

  /** Replays everything after each topic's cursor, repeating while the live buffer overflowed or the backplane blipped. */
  private async catchUp(conn: StreamConnection) {
    try {
      conn.replaying = true;
      do {
        conn.needsAnotherPass = false;
        for (const topic of conn.activeTopics()) {
          if (conn.closed) return;
          await this.replayTopic(conn, topic);
        }
      } while (conn.needsAnotherPass && !conn.closed);
    } catch (error) {
      // The store failed midway: end cleanly so the client resumes from its cursor (FR-047).
      this.logger.warn(`realtime replay failed: ${(error as Error).message}`);
      conn.close('error');
      return;
    }
    if (conn.closed) return;
    conn.replaying = false;
    const pending = conn.buffered;
    conn.buffered = [];
    for (const message of pending) this.send(conn, message, 'live');
  }

  private async replayTopic(conn: StreamConnection, topic: string) {
    const cursor = conn.cursor.get(topic);
    let from = '-';
    if (cursor) {
      const info = await this.readInfo(topic);
      const decision = decideReplay({
        cursor,
        now: this.now(),
        retentionMs: this.config.get('retentionMs'),
        exists: info.exists,
        latestId: info.latestId,
        maxDeletedId: info.maxDeletedId,
      });
      if (decision === 'nothing') return;
      if (decision === 'resync') {
        if (info.exists) conn.cursor.set(topic, info.latestId);
        else conn.cursor.delete(topic);
        this.metrics.resync.add(1);
        conn.write(formatResync(topic));
        return;
      }
      from = `(${cursor}`;
    }
    const page = this.config.get('replayPage');
    for (;;) {
      const entries = await this.redis.client.xrange(
        streamKey(topic),
        from,
        '+',
        'COUNT',
        page,
      );
      for (const [id, fields] of entries) {
        if (conn.closed) return;
        const message = this.parseEntry(topic, id, fields);
        if (message) this.send(conn, message, 'replayed');
        else conn.cursor.set(topic, id);
        // Replay is paced by the client: a backlog is read from the store, never piled up in memory (FR-030).
        await conn.waitForDrain();
      }
      if (conn.closed) return;
      if (entries.length < page) return;
      from = `(${entries[entries.length - 1][0]}`;
    }
  }

  private parseEntry(
    topic: string,
    id: string,
    fields: string[],
  ): RealtimeMessage | null {
    try {
      const type = fields[fields.indexOf('t') + 1];
      const data = JSON.parse(fields[fields.indexOf('d') + 1]);
      if (typeof type !== 'string') throw new Error('no type');
      return { id, topic, type, data };
    } catch {
      this.logger.warn(
        `realtime replay skipped an unreadable entry topic=${topic}`,
      );
      return null;
    }
  }

  private async readInfo(topic: string): Promise<StreamInfo> {
    let raw: unknown[];
    try {
      raw = (await this.redis.client.xinfo(
        'STREAM',
        streamKey(topic),
      )) as unknown[];
    } catch (error) {
      if (/no such key/i.test((error as Error).message))
        return { exists: false, latestId: '0-0', maxDeletedId: '0-0' };
      throw error;
    }
    const field = (name: string): string | undefined => {
      const i = raw.indexOf(name);
      return i >= 0 ? String(raw[i + 1]) : undefined;
    };
    return {
      exists: true,
      latestId: field('last-generated-id') ?? '0-0',
      maxDeletedId: field('max-deleted-entry-id') ?? '0-0',
    };
  }

  /** The backplane connection came back: every open connection reads what it missed from its cursor (FR-046). */
  private gapFill() {
    for (const conn of this.connections) {
      if (conn.closed || !conn.headersSent) continue;
      if (conn.replaying) conn.needsAnotherPass = true;
      else void this.catchUp(conn);
    }
  }

  // ---- revocation ---------------------------------------------------------------------------------------------

  private applyRevocation(notice: RevocationNotice) {
    for (const conn of [...this.connections]) {
      if (notice.userId !== undefined && conn.userId !== notice.userId)
        continue;
      for (const [topic, state] of [...conn.topics]) {
        const shape = parseTopicShape(topic);
        if (
          !shape ||
          shape.prefix !== notice.prefix ||
          shape.id !== notice.id ||
          (notice.suffix !== undefined && shape.suffix !== notice.suffix) ||
          state.state === 'revoked'
        )
          continue;
        const wasAdmitting = state.state === 'admitting';
        state.state = 'revoked';
        this.metrics.revocations.add(1);
        if (!wasAdmitting && conn.headersSent)
          this.finishRevocation(conn, topic);
      }
    }
  }

  private finishRevocation(conn: StreamConnection, topic: string) {
    const state = conn.topics.get(topic);
    conn.write(formatRevoked(topic));
    void state?.release?.().catch(() => undefined);
    conn.buffered = conn.buffered.filter((m) => m.topic !== topic);
    if (conn.activeTopics().length === 0) conn.close('revoked');
  }

  onModuleDestroy() {
    this.resubscribeOff?.();
    for (const conn of [...this.connections]) conn.close('shutdown');
  }
}
