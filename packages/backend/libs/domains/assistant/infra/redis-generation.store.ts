import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { ApiConfigService } from '@app/common/config';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type {
  GenerationEvent,
  GenerationMeta,
  GenerationStore,
  StoredEvent,
} from '../domain/assistant-ports';
import type { GenerationState } from '../domain/generation-state';

/** Presence of a viewer and liveness of the generator stay valid this long after their last refresh. */
export const VIEWER_TTL_MS = 5_000;
export const ALIVE_TTL_MS = 5_000;
/** The longest a generation runs plus slack: the stream and meta outlive the turn deadline by the replay window. */
const RUNNING_RETENTION_MS = 6 * 60_000;
const STREAM_MAX_LEN = '20000';

/** Hash tag keeps every key of one generation in one cluster slot, so the Lua guards stay atomic. */
const tag = (userId: string, messageId: string) => `{${userId}:${messageId}}`;
const base = (userId: string, messageId: string) =>
  `assistant:gen:${tag(userId, messageId)}`;
const streamKey = (u: string, m: string) => `${base(u, m)}:stream`;
const metaKey = (u: string, m: string) => `${base(u, m)}:meta`;
const aliveKey = (u: string, m: string) => `${base(u, m)}:alive`;
const cancelKey = (u: string, m: string) => `${base(u, m)}:cancel`;
const viewersKey = (u: string, m: string) => `${base(u, m)}:viewers`;

/**
 * Terminal-once guard (AS-30/AS-31): appends the terminal event and flips the state in one script, only while the state is
 * `running`. A racing reporter finds the state already final and gets nil. KEYS: stream, meta. ARGV: type, data, now,
 * retention ms, maxlen.
 */
const FINISH = `
local state = redis.call('HGET', KEYS[2], 'state')
if state ~= 'running' then return false end
local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[5], '*', 't', ARGV[1], 'd', ARGV[2])
redis.call('HSET', KEYS[2], 'state', ARGV[1], 'endedAt', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return id`;

const TERMINAL: Record<string, GenerationState> = {
  done: 'done',
  refusal: 'refusal',
  error: 'error',
};

const toStored = ([id, fields]: [string, string[]]): StoredEvent => ({
  id,
  event: {
    type: fields[1],
    data: JSON.parse(fields[3]),
  } as GenerationEvent,
});

/**
 * Redis-backed generation store (replaces `generation-buffer.ts`). Every key carries the owner: a foreign or unknown
 * message id is a plain miss (G2). Events are XADDed to a per-generation stream whose entry id is the SSE id.
 */
@Injectable()
export class RedisGenerationStore implements GenerationStore {
  private readonly emitter = new EventEmitter().setMaxListeners(0);
  private readonly local = new Set<string>();

  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
  ) {}

  private get replayWindowMs(): number {
    return this.config.get('assistant_replay_window_ms');
  }

  async start(
    userId: string,
    messageId: string,
    conversationId: string,
  ): Promise<void> {
    const meta = metaKey(userId, messageId);
    await this.redis.client
      .multi()
      .hset(meta, {
        conversationId,
        state: 'running',
        startedAt: String(Date.now()),
      })
      .pexpire(meta, RUNNING_RETENTION_MS + this.replayWindowMs)
      .set(
        aliveKey(userId, messageId),
        '1',
        'PX',
        ALIVE_TTL_MS,
      )
      .exec();
    this.local.add(`${userId}:${messageId}`);
  }

  async append(
    userId: string,
    messageId: string,
    event: GenerationEvent,
  ): Promise<string> {
    const stream = streamKey(userId, messageId);
    const id = (await this.redis.client.xadd(
      stream,
      'MAXLEN',
      '~',
      STREAM_MAX_LEN,
      '*',
      't',
      event.type,
      'd',
      JSON.stringify(event.data),
    ))!;
    await this.redis.client.pexpire(
      stream,
      RUNNING_RETENTION_MS + this.replayWindowMs,
    );
    this.emitter.emit(`${userId}:${messageId}`);
    return id;
  }

  async finish(
    userId: string,
    messageId: string,
    event: GenerationEvent,
  ): Promise<StoredEvent | null> {
    if (!TERMINAL[event.type]) throw new Error('finish takes a terminal event');
    const id = (await this.redis.client.eval(
      FINISH,
      2,
      streamKey(userId, messageId),
      metaKey(userId, messageId),
      event.type,
      JSON.stringify(event.data),
      String(Date.now()),
      String(this.replayWindowMs),
      STREAM_MAX_LEN,
    )) as string | null;
    this.local.delete(`${userId}:${messageId}`);
    if (!id) return null;
    this.emitter.emit(`${userId}:${messageId}`);
    return { id, event };
  }

  async read(
    userId: string,
    messageId: string,
    afterId: string | undefined,
    limit: number,
  ): Promise<StoredEvent[] | null> {
    if (!(await this.redis.client.exists(metaKey(userId, messageId))))
      return null;
    const rows = await this.redis.client.xrange(
      streamKey(userId, messageId),
      afterId ? `(${afterId}` : '-',
      '+',
      'COUNT',
      limit,
    );
    return rows.map(toStored);
  }

  async wait(
    userId: string,
    messageId: string,
    afterId: string,
    blockMs: number,
  ): Promise<StoredEvent[] | null> {
    const key = `${userId}:${messageId}`;
    const first = await this.read(userId, messageId, afterId, 500);
    if (first === null || first.length) return first;
    if (this.local.has(key)) {
      // The generator is on this instance: wake on its append instead of polling Redis.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, blockMs);
        const done = () => {
          clearTimeout(timer);
          this.emitter.off(key, done);
          resolve();
        };
        this.emitter.once(key, done);
      });
      return this.read(userId, messageId, afterId, 500);
    }
    // Another instance owns the generator: one blocking read on a short-lived connection (a blocked connection cannot
    // serve other commands), not a poll every 300 ms per viewer.
    const blocking = this.redis.client.duplicate();
    try {
      await blocking.xread(
        'BLOCK',
        Math.max(1, blockMs),
        'STREAMS',
        streamKey(userId, messageId),
        afterId,
      );
      return await this.read(userId, messageId, afterId, 500);
    } finally {
      blocking.disconnect();
    }
  }

  async meta(userId: string, messageId: string): Promise<GenerationMeta | null> {
    const [fields, cancel] = await Promise.all([
      this.redis.client.hgetall(metaKey(userId, messageId)),
      this.redis.client.exists(cancelKey(userId, messageId)),
    ]);
    if (!fields.state) return null;
    return {
      conversationId: fields.conversationId,
      state: fields.state as GenerationState,
      startedAt: Number(fields.startedAt),
      endedAt: fields.endedAt ? Number(fields.endedAt) : undefined,
      cancelRequested: cancel === 1,
    };
  }

  async requestCancel(
    userId: string,
    messageId: string,
  ): Promise<GenerationState | null> {
    const state = (await this.redis.client.hget(
      metaKey(userId, messageId),
      'state',
    )) as GenerationState | null;
    if (!state) return null;
    if (state !== 'running') return state;
    await this.redis.client.set(
      cancelKey(userId, messageId),
      '1',
      'PX',
      RUNNING_RETENTION_MS + this.replayWindowMs,
    );
    this.emitter.emit(`${userId}:${messageId}:cancel`);
    return state;
  }

  onCancel(userId: string, messageId: string, listener: () => void) {
    const event = `${userId}:${messageId}:cancel`;
    this.emitter.once(event, listener);
    return () => void this.emitter.off(event, listener);
  }

  async heartbeat(userId: string, messageId: string): Promise<void> {
    await this.redis.client.set(
      aliveKey(userId, messageId),
      '1',
      'PX',
      ALIVE_TTL_MS,
    );
  }

  async touchViewer(
    userId: string,
    messageId: string,
    viewerId: string,
  ): Promise<void> {
    const key = viewersKey(userId, messageId);
    await this.redis.client
      .multi()
      .zadd(key, Date.now() + VIEWER_TTL_MS, viewerId)
      .pexpire(key, RUNNING_RETENTION_MS + this.replayWindowMs)
      .exec();
  }

  async hasViewers(userId: string, messageId: string): Promise<boolean> {
    return (
      (await this.redis.client.zcount(
        viewersKey(userId, messageId),
        Date.now(),
        '+inf',
      )) > 0
    );
  }

  async isLost(userId: string, messageId: string): Promise<boolean> {
    const [state, alive] = await Promise.all([
      this.redis.client.hget(metaKey(userId, messageId), 'state'),
      this.redis.client.exists(aliveKey(userId, messageId)),
    ]);
    return state === 'running' && alive === 0;
  }

  localGenerations(): number {
    return this.local.size;
  }
}
