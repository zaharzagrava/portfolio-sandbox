import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { HashRing } from '../domain/hash-ring';

const REGISTRY = 'collab:instances';
const STALE_MS = 15_000;
const REFRESH_MS = 2_000;

/**
 * Live collab instances in a Redis ZSET (member = "<id>|<publicUrl>", score =
 * last heartbeat). Every process (collab instances AND the core API that hands
 * out routes) builds the same ring from the same member list, so they agree on
 * the owner of each draft without talking to each other.
 */
@Injectable()
export class CollabInstanceRegistry implements OnModuleDestroy {
  private ring = new HashRing([]);
  private urls = new Map<string, string>();
  private refreshedAt = 0;
  private heartbeat?: NodeJS.Timeout;
  private self?: string;

  constructor(private readonly redis: RedisService) {}

  /** Called by collab instances only. */
  async register(id: string, publicUrl: string): Promise<void> {
    this.self = `${id}|${publicUrl}`;
    clearInterval(this.heartbeat);
    await this.heartbeatNow();
    this.heartbeat = setInterval(() => void this.heartbeatNow().catch(() => undefined), STALE_MS / 3);
    this.heartbeat.unref();
  }

  /** Re-announces this instance right away (also used by tests after they wipe Redis). */
  async heartbeatNow(): Promise<void> {
    if (!this.self) return;
    await this.redis.client.zadd(REGISTRY, Date.now(), this.self);
    await this.refresh(true);
  }

  async onModuleDestroy() {
    clearInterval(this.heartbeat);
    // Leave the ring immediately on graceful shutdown; clients reconnect to the new owner.
    if (this.self) await this.redis.client.zrem(REGISTRY, this.self).catch(() => undefined);
  }

  async ownerOf(draftId: string): Promise<{ id: string; url: string } | null> {
    await this.refresh(this.urls.size === 0); // an empty ring can't answer: re-read instead of waiting out the cache
    const id = this.ring.nodeFor(draftId);
    return id ? { id, url: this.urls.get(id)! } : null;
  }

  private async refresh(force = false) {
    if (!force && Date.now() - this.refreshedAt < REFRESH_MS) return;
    await this.redis.client.zremrangebyscore(REGISTRY, '-inf', Date.now() - STALE_MS * 4);
    const members = await this.redis.client.zrangebyscore(REGISTRY, Date.now() - STALE_MS, '+inf');
    this.urls = new Map(members.map((m) => m.split('|') as [string, string]));
    this.ring = new HashRing([...this.urls.keys()]);
    this.refreshedAt = Date.now();
  }
}
