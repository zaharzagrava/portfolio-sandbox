import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { hostname } from 'node:os';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { RealtimeMessage } from '@app/infrastructure/realtime/topics';
import { Reservoir, firehoseTopic, LiveComment, viewersKey } from '@app/domains/launch-events';
import { SubscriptionHub } from '../topic-stream/subscription-hub.service';

export const TICK_MS = 250;
/** 20 comments/s per viewer - more than anyone can read. */
export const SAMPLED_PER_TICK = 5;
const MAX_PRIORITY_PER_TICK = 10;
const VIEWER_HEARTBEAT_MS = 5_000;

export interface LiveViewer {
  userId?: string;
  send(event: string, data: unknown): void;
}

/**
 * One per (gateway instance, live stream) - the "regional fan-out" tier of
 * 10/06 #15. The instance subscribes ONCE to the stream's firehose however
 * many of its 50k viewers watch, samples each 250 ms window with a reservoir
 * (k = 5), and writes one batched SSE event per viewer per tick:
 *   priority comments (shop staff) + the viewer's OWN comments + the sample.
 * Fan-out work = viewers × 4 small writes/s, independent of the comment rate.
 * Low-rate control events (pin, removals, stats, status) pass straight through.
 */
export class StreamBatcher {
  readonly viewers = new Set<LiveViewer>();
  private readonly reservoir = new Reservoir<LiveComment>(SAMPLED_PER_TICK);
  private priority: LiveComment[] = [];
  private own = new Map<string, LiveComment[]>();
  private readonly watchingUsers = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;

  constructor(readonly streamId: string) {
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  add(viewer: LiveViewer) {
    this.viewers.add(viewer);
    if (viewer.userId) this.watchingUsers.set(viewer.userId, (this.watchingUsers.get(viewer.userId) ?? 0) + 1);
  }

  remove(viewer: LiveViewer) {
    this.viewers.delete(viewer);
    if (viewer.userId) {
      const left = (this.watchingUsers.get(viewer.userId) ?? 1) - 1;
      if (left <= 0) this.watchingUsers.delete(viewer.userId);
      else this.watchingUsers.set(viewer.userId, left);
    }
  }

  onComment(comment: LiveComment) {
    if (comment.priority) {
      if (this.priority.length < MAX_PRIORITY_PER_TICK) this.priority.push(comment);
    } else {
      this.reservoir.offer(comment);
    }
    if (this.watchingUsers.has(comment.authorId)) this.own.set(comment.authorId, [...(this.own.get(comment.authorId) ?? []), comment]);
  }

  broadcast(event: string, data: unknown) {
    for (const viewer of this.viewers) viewer.send(event, data);
  }

  tick() {
    const { sample, seen } = this.reservoir.drain();
    const priority = this.priority;
    const own = this.own;
    this.priority = [];
    this.own = new Map();
    if (sample.length === 0 && priority.length === 0 && own.size === 0) return;

    const shared = [...priority, ...sample];
    for (const viewer of this.viewers) {
      const mine = viewer.userId ? (own.get(viewer.userId) ?? []) : [];
      const items = mine.length ? dedupe([...priority, ...mine, ...sample]) : shared;
      viewer.send('comments', { items, rate: Math.round((seen + priority.length) * (1000 / TICK_MS)) });
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

function dedupe(items: LiveComment[]): LiveComment[] {
  const seen = new Set<string>();
  return items.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/** Creates batchers on the first local viewer of a stream and tears them down after the last one leaves. */
@Injectable()
export class LiveBatcherRegistry implements OnModuleDestroy {
  private readonly batchers = new Map<string, { batcher: StreamBatcher; unsubscribe: () => Promise<void> }>();
  private readonly instance = `${hostname()}-${process.pid}`;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly hub: SubscriptionHub,
    private readonly redis: RedisService,
  ) {
    this.heartbeat = setInterval(() => void this.reportViewers().catch(() => undefined), VIEWER_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  async join(streamId: string, viewer: LiveViewer): Promise<() => Promise<void>> {
    let entry = this.batchers.get(streamId);
    if (!entry) {
      const batcher = new StreamBatcher(streamId);
      const unsubscribers = await Promise.all([
        this.hub.subscribe(firehoseTopic(streamId), (m: RealtimeMessage) => batcher.onComment(m.data as LiveComment)),
        this.hub.subscribe(`stream:${streamId}`, (m: RealtimeMessage) => batcher.broadcast(m.type, m.data)),
      ]);
      entry = { batcher, unsubscribe: async () => void (await Promise.all(unsubscribers.map((u) => u()))) };
      this.batchers.set(streamId, entry);
    }
    entry.batcher.add(viewer);

    return async () => {
      const current = this.batchers.get(streamId);
      if (!current) return;
      current.batcher.remove(viewer);
      if (current.batcher.viewers.size === 0) {
        this.batchers.delete(streamId);
        current.batcher.stop();
        await current.unsubscribe();
        await this.redis.client.hdel(viewersKey(streamId), this.instance).catch(() => undefined);
      }
    };
  }

  batcher(streamId: string): StreamBatcher | undefined {
    return this.batchers.get(streamId)?.batcher;
  }

  /** `<count>:<ts>` per instance; the ticker sums fresh entries only. */
  async reportViewers() {
    const pipeline = this.redis.client.pipeline();
    for (const [streamId, { batcher }] of this.batchers) {
      pipeline.hset(viewersKey(streamId), this.instance, `${batcher.viewers.size}:${Date.now()}`);
      pipeline.expire(viewersKey(streamId), 60);
    }
    await pipeline.exec();
  }

  async onModuleDestroy() {
    clearInterval(this.heartbeat);
    for (const { batcher, unsubscribe } of this.batchers.values()) {
      batcher.stop();
      await unsubscribe();
    }
    this.batchers.clear();
  }
}
