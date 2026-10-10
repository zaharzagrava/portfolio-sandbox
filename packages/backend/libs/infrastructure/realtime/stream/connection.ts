import type { Response } from 'express';
import type { RealtimeConfigValues } from '../config/realtime.config';
import type { ClosedReason } from '../metrics/realtime-metrics';
import type { RealtimeMessage } from '../topics';

export type TopicState = 'admitting' | 'active' | 'revoked';

export interface ConnectionTopic {
  state: TopicState;
  /** Releases this topic's hub subscription; idempotent. */
  release?: () => Promise<void>;
}

export interface ConnectionPrincipal {
  userId?: string;
  roles: string[];
  address: string;
}

/**
 * Everything one open response owns (S51 FR-028): its cursor, the bounded buffer of live messages held back while a
 * replay runs, its topic subscriptions and its timers. `close` is idempotent and total: wherever the close arrives from
 * (client abort during connect or replay, slow or stalled writer, revocation, shutdown), every timer is cleared and
 * every subscription released.
 */
export class StreamConnection {
  closed = false;
  headersSent = false;
  /** Last delivered (or baselined) position per topic: the `id:` the client sends back as Last-Event-ID. */
  readonly cursor = new Map<string, string>();
  readonly topics = new Map<string, ConnectionTopic>();

  /** Live messages held while a replay runs; bounded by `replayBuffer`. */
  buffered: RealtimeMessage[] = [];
  replaying = true;
  /** A bounded buffer overflowed (or the backplane blipped): another replay pass must run. */
  needsAnotherPass = false;
  delivered = 0;
  readonly openedAt = Date.now();

  private heartbeat?: NodeJS.Timeout;
  private stall?: NodeJS.Timeout;

  constructor(
    readonly id: number,
    readonly principal: ConnectionPrincipal,
    private readonly res: Response,
    private readonly limits: Pick<
      RealtimeConfigValues,
      'maxBufferedBytes' | 'stallMs' | 'heartbeatMs'
    >,
    private readonly onClose: (reason: ClosedReason | 'refused') => void,
  ) {}

  get userId() {
    return this.principal.userId;
  }

  /** Activate topics with state `active`. */
  activeTopics(): string[] {
    return [...this.topics.entries()]
      .filter(([, t]) => t.state === 'active')
      .map(([topic]) => topic);
  }

  startHeartbeat(frame: string) {
    this.heartbeat = setInterval(
      () => this.write(frame),
      this.limits.heartbeatMs,
    );
    this.heartbeat.unref?.();
  }

  /**
   * Writes one complete frame. A client that cannot keep up is dropped: pending output over the byte bound closes the
   * connection (`slow`), and a write that stays blocked longer than the stall limit closes it (`stalled`).
   */
  write(frame: string): boolean {
    if (this.closed) return false;
    let ok: boolean;
    try {
      ok = this.res.write(frame);
    } catch {
      this.close('error');
      return false;
    }
    if (!ok) {
      if (this.res.writableLength > this.limits.maxBufferedBytes) {
        this.close('slow');
        return false;
      }
      if (!this.stall) {
        this.stall = setTimeout(
          () => this.close('stalled'),
          this.limits.stallMs,
        );
        this.stall.unref?.();
        this.res.once('drain', () => {
          if (this.stall) clearTimeout(this.stall);
          this.stall = undefined;
        });
      }
    }
    return true;
  }

  /** Resolves when the socket drained or the connection closed (replay waits here instead of buffering a backlog). */
  waitForDrain(): Promise<void> {
    if (this.closed || !this.res.writableNeedDrain) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.res.off('drain', done);
        this.res.off('close', done);
        resolve();
      };
      this.res.once('drain', done);
      this.res.once('close', done);
    });
  }

  /**
   * `refused`: the request failed before the stream started; the thrown problem is the response, so the response is left
   * alone. Otherwise the response ends (or, for a client that cannot keep up, is destroyed).
   */
  close(reason: ClosedReason | 'refused') {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.stall) clearTimeout(this.stall);
    this.heartbeat = this.stall = undefined;
    this.buffered = [];
    for (const topic of this.topics.values()) {
      void topic.release?.().catch(() => undefined);
    }
    if (this.headersSent) {
      try {
        if (reason === 'slow' || reason === 'stalled') this.res.destroy();
        else if (!this.res.writableEnded) this.res.end();
      } catch {
        /* socket already gone */
      }
    }
    this.onClose(reason);
  }
}
