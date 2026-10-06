import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { RedisService } from '@app/infrastructure/redis/redis.service';

export type GenerationEventType = 'meta' | 'text' | 'tool' | 'done' | 'error' | 'refusal';
export interface GenerationEvent {
  /** Redis Stream id - doubles as the SSE `id:` (Last-Event-ID on reconnect). */
  id: string;
  type: GenerationEventType;
  data: Record<string, unknown>;
}

export const TERMINAL_EVENTS: GenerationEventType[] = ['done', 'error', 'refusal'];

const key = (messageId: string) => `assistant:gen:{${messageId}}`;
const metaKey = (messageId: string) => `${key(messageId)}:meta`;
const viewerKey = (messageId: string) => `${key(messageId)}:viewer`;
const cancelKey = (messageId: string) => `${key(messageId)}:cancel`;

/** Finished generations stay replayable this long (a phone that lost signal mid-answer). */
const RETAIN_MS = 10 * 60_000;
export const VIEWER_TTL_MS = 5_000;

/** Stream ids are "<ms>-<seq>": compare numerically, not as strings. */
export const compareStreamIds = (a: string, b: string) => {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am - bm || as - bs;
};

/**
 * Durable, replayable output of one assistant turn (SD-42 resumability).
 * Every event is XADDed to a per-message Redis Stream; a viewer on the same
 * instance as the generator also gets it pushed in-process (the common path:
 * the POST that started the turn). A viewer that reconnects elsewhere replays
 * from its Last-Event-ID and then polls - rare, so no fleet-wide pub/sub.
 *
 * Viewer presence drives abort-on-disconnect: local viewers are counted in
 * memory, remote ones refresh a short-TTL key.
 */
@Injectable()
export class GenerationBuffer {
  private readonly local = new EventEmitter().setMaxListeners(0);
  private readonly localViewers = new Map<string, number>();
  private readonly localGenerations = new Set<string>();

  constructor(private readonly redis: RedisService) {}

  async open(messageId: string, owner: { userId: string; conversationId: string }): Promise<void> {
    this.localGenerations.add(messageId);
    await this.redis.client.hset(metaKey(messageId), owner);
    await this.redis.client.pexpire(metaKey(messageId), RETAIN_MS * 3);
  }

  async owner(messageId: string): Promise<{ userId: string; conversationId: string } | null> {
    const meta = await this.redis.client.hgetall(metaKey(messageId));
    return meta.userId ? { userId: meta.userId, conversationId: meta.conversationId } : null;
  }

  async append(messageId: string, type: GenerationEventType, data: Record<string, unknown>): Promise<void> {
    const id = (await this.redis.client.xadd(key(messageId), 'MAXLEN', '~', '20000', '*', 't', type, 'd', JSON.stringify(data)))!;
    this.local.emit(messageId, { id, type, data } satisfies GenerationEvent);
  }

  async close(messageId: string): Promise<void> {
    this.localGenerations.delete(messageId);
    await this.redis.client.pexpire(key(messageId), RETAIN_MS);
  }

  isLocal(messageId: string) {
    return this.localGenerations.has(messageId);
  }

  async replay(messageId: string, afterId: string | null): Promise<GenerationEvent[]> {
    const rows = await this.redis.client.xrange(key(messageId), afterId ? `(${afterId}` : '-', '+', 'COUNT', 5000);
    return rows.map(([id, fields]) => ({ id, type: fields[1] as GenerationEventType, data: JSON.parse(fields[3]) }));
  }

  subscribe(messageId: string, listener: (event: GenerationEvent) => void): () => void {
    this.local.on(messageId, listener);
    this.localViewers.set(messageId, (this.localViewers.get(messageId) ?? 0) + 1);
    return () => {
      this.local.off(messageId, listener);
      const n = (this.localViewers.get(messageId) ?? 1) - 1;
      if (n <= 0) this.localViewers.delete(messageId);
      else this.localViewers.set(messageId, n);
    };
  }

  async touchRemoteViewer(messageId: string): Promise<void> {
    await this.redis.client.set(viewerKey(messageId), '1', 'PX', VIEWER_TTL_MS);
  }

  async hasViewer(messageId: string): Promise<boolean> {
    return (this.localViewers.get(messageId) ?? 0) > 0 || (await this.redis.client.exists(viewerKey(messageId))) === 1;
  }

  async requestCancel(messageId: string): Promise<void> {
    await this.redis.client.set(cancelKey(messageId), '1', 'PX', RETAIN_MS);
    this.local.emit(`${messageId}:cancel`);
  }

  async isCancelled(messageId: string): Promise<boolean> {
    return (await this.redis.client.exists(cancelKey(messageId))) === 1;
  }

  onLocalCancel(messageId: string, fn: () => void): () => void {
    this.local.once(`${messageId}:cancel`, fn);
    return () => this.local.off(`${messageId}:cancel`, fn);
  }
}
