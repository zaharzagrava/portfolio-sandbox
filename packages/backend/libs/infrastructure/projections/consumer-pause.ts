import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';

/** How often a runner looks at its pause flag; a pause is honoured well inside the 2 s the contract promises. */
export const PAUSE_POLL_MS = 500;

const REPLAY_TTL_S = 600;
const LAST_PROCESSED_TTL_S = 90 * 24 * 3600;

export const pauseKey = (group: string): string => `consumer:pause:${group}`;
export const replayKey = (group: string): string => `consumer:replay:${group}`;
export const lastProcessedKey = (group: string): string =>
  `consumer:last-processed:${group}`;

/**
 * Operator state of consumer groups, shared by every process through Redis (S53 R-22; keyspace in the S53 page):
 *  - `consumer:pause:<group>`: present while paused, no expiry (a pause must survive restarts);
 *  - `consumer:replay:<group>`: target offsets (`topic|partition` to offset) the owning runner seeks to;
 *  - `consumer:last-processed:<group>`: when the group last finished a batch.
 */
@Injectable()
export class ConsumerPauseFlags {
  constructor(private readonly redis: RedisService) {}

  /** Sets the flag unless present (atomic: concurrent pauses leave one flag). Returns whether this call set it. */
  async pause(group: string, by: string, nowIso: string): Promise<boolean> {
    const set = await this.redis.client.set(
      pauseKey(group),
      JSON.stringify({ pausedAt: nowIso, by }),
      'NX',
    );
    return set === 'OK';
  }

  async resume(group: string): Promise<void> {
    await this.redis.client.del(pauseKey(group));
  }

  /** True when any of the flags (the group's own and its canonical aliases') is set. */
  async isPaused(groups: string[]): Promise<boolean> {
    const values = await this.redis.client.mget(...groups.map(pauseKey));
    return values.some((v) => v !== null);
  }

  async setReplay(
    group: string,
    targets: Record<string, number>,
  ): Promise<void> {
    const entries = Object.entries(targets);
    if (entries.length === 0) return;
    await this.redis.client
      .multi()
      .hset(replayKey(group), Object.fromEntries(entries))
      .expire(replayKey(group), REPLAY_TTL_S)
      .exec();
  }

  async pendingReplay(group: string): Promise<Record<string, number>> {
    const raw = await this.redis.client.hgetall(replayKey(group));
    return Object.fromEntries(
      Object.entries(raw).map(([field, offset]) => [field, Number(offset)]),
    );
  }

  async replayDone(group: string, field: string): Promise<void> {
    await this.redis.client.hdel(replayKey(group), field);
  }

  async touch(group: string, nowIso: string): Promise<void> {
    await this.redis.client.set(
      lastProcessedKey(group),
      nowIso,
      'EX',
      LAST_PROCESSED_TTL_S,
    );
  }

  async lastProcessed(groups: string[]): Promise<string | null> {
    if (groups.length === 0) return null;
    const values = (
      await this.redis.client.mget(...groups.map(lastProcessedKey))
    ).filter((v): v is string => v !== null);
    return values.length === 0 ? null : values.sort().at(-1)!;
  }
}
