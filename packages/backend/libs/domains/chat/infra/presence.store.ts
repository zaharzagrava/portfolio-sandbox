import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { PresenceReader, PresenceStore } from '../domain/ports';
import { Inject } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { CHAT_SETTINGS } from '../domain/chat-settings.token';
import type { ChatSettings } from '../domain/config';
import { chatPresenceUnavailableCounter } from '../domain/chat-metrics';

const key = (userId: string) => `presence:{${userId}}`;
/** The key outlives the 60 s of "online" so the previous heartbeat is still known when it lapsed; it only collects garbage. */
const KEY_TTL_S = 600;

/**
 * Presence lives in Redis only, never in the primary database (FR-035, AS-40). The value is the epoch ms of the last
 * heartbeat, written with `SET … GET` so the previous value and the new one change atomically: of twenty simultaneous
 * first heartbeats exactly one sees "no previous" and announces the transition.
 */
@Injectable()
export class RedisPresenceStore implements PresenceStore {
  constructor(private readonly redis: RedisService) {}

  async heartbeat(
    userId: string,
    now: Date,
  ): Promise<{ previous: number | null }> {
    const previous = await this.redis.client.set(
      key(userId),
      String(now.getTime()),
      'EX',
      KEY_TTL_S,
      'GET',
    );
    return { previous: previous === null ? null : Number(previous) };
  }

  async multiGet(userIds: string[]): Promise<Map<string, number | null>> {
    if (userIds.length === 0) return new Map();
    const values = await this.redis.client.mget(...userIds.map(key));
    return new Map(
      userIds.map((id, i) => [
        id,
        values[i] === null ? null : Number(values[i]),
      ]),
    );
  }
}

/** The offline check's view of presence: unknown when the store cannot answer (a duplicate push beats a missed one). */
@Injectable()
export class PresenceReaderAdapter implements PresenceReader {
  constructor(
    private readonly store: RedisPresenceStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CHAT_SETTINGS) private readonly settings: ChatSettings,
  ) {}

  async isOnline(userId: string): Promise<boolean | 'unknown'> {
    try {
      const seen = (await this.store.multiGet([userId])).get(userId) ?? null;
      return (
        seen !== null &&
        this.clock.now().getTime() - seen < this.settings.presenceTtlS * 1000
      );
    } catch {
      chatPresenceUnavailableCounter.add(1);
      return 'unknown';
    }
  }
}
