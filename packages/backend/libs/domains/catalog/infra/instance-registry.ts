import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { HashRing } from '../domain/hash-ring';
import { DRAFT_LIMITS } from '../domain/draft-limits';
import type { RingMember, RingRegistry } from '../domain/draft-ports';
import { bestEffort, withTimeout } from './timeouts';

export const RING_KEY = 'collab:ring';

/**
 * Live editing instances in a Redis sorted set (member = "<id>|<publicUrl>", score = last heartbeat on the shared clock).
 * Every process (editing instances AND the core API that hands out routes) builds the same ring from the same member list,
 * so they agree on the owner of each draft without talking to each other. An instance expires 15 seconds after its last
 * heartbeat. Redis calls are bounded by 250 ms; during an outage the last known ring stays in use.
 */
@Injectable()
export class RedisRingRegistry implements RingRegistry, OnModuleDestroy {
  private readonly logger = new Logger(RedisRingRegistry.name);
  private ring = new HashRing([]);
  private members_ = new Map<string, RingMember>();
  private refreshedAt = 0;
  private heartbeat?: NodeJS.Timeout;
  private self?: RingMember;
  private isRegistered = false;
  private readonly handlers = new Set<() => void>();
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly redis: RedisService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async register(member: RingMember): Promise<void> {
    this.self = member;
    clearInterval(this.heartbeat);
    await this.heartbeatNow();
    this.isRegistered = true;
    this.heartbeat = setInterval(
      () => void this.heartbeatNow().catch(() => undefined),
      DRAFT_LIMITS.ringHeartbeatMs,
    );
    this.heartbeat.unref();
  }

  registered(): boolean {
    return this.isRegistered;
  }

  /** Re-announces this instance right away (also used by tests after they wipe Redis). */
  async heartbeatNow(): Promise<void> {
    if (!this.self) return;
    const entry = `${this.self.id}|${this.self.url}`;
    await withTimeout('ring heartbeat', DRAFT_LIMITS.redisTimeoutMs, () =>
      this.redis.client.zadd(RING_KEY, this.clock.nowMs(), entry),
    );
    await this.refreshNow();
  }

  async leave(): Promise<void> {
    clearInterval(this.heartbeat);
    this.isRegistered = false;
    if (this.self)
      await bestEffort('ring leave', DRAFT_LIMITS.redisTimeoutMs, () =>
        this.redis.client.zrem(RING_KEY, `${this.self!.id}|${this.self!.url}`),
      );
    await this.refreshNow().catch(() => undefined);
  }

  async onModuleDestroy() {
    clearInterval(this.heartbeat);
    // Leave the ring immediately on graceful shutdown; clients reconnect to the new owner.
    await this.leave();
  }

  async ownerOf(draftId: string): Promise<RingMember | null> {
    // An empty ring cannot answer: re-read instead of waiting out the cache.
    if (
      this.members_.size === 0 ||
      Date.now() - this.refreshedAt >= DRAFT_LIMITS.ringRefreshMs
    )
      await this.refreshNow().catch(() => undefined);
    const id = this.ring.nodeFor(draftId);
    return id ? (this.members_.get(id) ?? null) : null;
  }

  async members(): Promise<RingMember[]> {
    await this.refreshNow().catch(() => undefined);
    return [...this.members_.values()];
  }

  onChange(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  refreshNow(): Promise<void> {
    this.refreshing ??= this.read().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async read(): Promise<void> {
    const now = this.clock.nowMs();
    const live = await withTimeout(
      'ring read',
      DRAFT_LIMITS.redisTimeoutMs,
      async () => {
        await this.redis.client.zremrangebyscore(
          RING_KEY,
          '-inf',
          now - DRAFT_LIMITS.ringTtlMs * 4,
        );
        return this.redis.client.zrangebyscore(
          RING_KEY,
          now - DRAFT_LIMITS.ringTtlMs,
          '+inf',
        );
      },
    );
    const next = new Map<string, RingMember>();
    for (const entry of live) {
      const at = entry.indexOf('|');
      if (at <= 0) continue;
      const id = entry.slice(0, at);
      next.set(id, { id, url: entry.slice(at + 1) });
    }
    this.refreshedAt = Date.now();
    const changed =
      next.size !== this.members_.size ||
      [...next.values()].some((m) => this.members_.get(m.id)?.url !== m.url);
    this.members_ = next;
    this.ring = new HashRing([...next.keys()]);
    if (changed)
      for (const handler of this.handlers)
        try {
          handler();
        } catch (error) {
          this.logger.warn(
            `ring change handler failed: ${(error as Error).name}`,
          );
        }
  }
}
