import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { ApiConfigService } from '@app/common/config';
import {
  activeKey,
  celebrityRecentsKey,
  FEED_TTL,
  followedCelebritiesKey,
  rebuildLockKey,
  timelineCompleteKey,
  timelineKey,
} from '../domain/feed-keys';
import {
  FEED_REDIS_CLIENT,
  TimelineUnavailableError,
  type TimelineEntryRow,
  type TimelineStore,
} from '../domain/ports';
import { RANK_PAGE } from './rank-scripts';

/** KEYS[1] = timeline. ARGV = score, member, window, ttl: adds the entry, trims to the window, renews the expiry. */
const PUSH = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
local over = redis.call('ZCARD', KEYS[1]) - tonumber(ARGV[3])
if over > 0 then redis.call('ZREMRANGEBYRANK', KEYS[1], 0, over - 1) end
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;

/**
 * `PUSH` for a user's timeline. KEYS[2] = the completion marker: a rebuild that found nothing records "complete and
 * empty" (`e`); the first push makes the timeline exist, so the marker becomes the plain one (a timeline lost later is
 * then told apart from one that was always empty).
 */
const PUSH_TIMELINE = `
if redis.call('GET', KEYS[2]) == 'e' then redis.call('SET', KEYS[2], '1', 'KEEPTTL') end
${PUSH}`;

/** Like `PUSH` but only when the key exists: a lost key is rebuilt from history, never half-filled. */
const PUSH_IF_EXISTS = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
${PUSH}`;

/** Page of a ZSET that may be absent (nil reply) after a cursor; see `RANK_PAGE`. */
const PAGE_IF_EXISTS = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
${RANK_PAGE}`;

const FULL_MARK = '1';
const EMPTY_MARK = 'e';

const toEntries = (flat: unknown): TimelineEntryRow[] => {
  const list = flat as string[];
  const out: TimelineEntryRow[] = [];
  for (let i = 0; i < list.length; i += 2)
    out.push({ itemId: list[i], ms: Number(list[i + 1]) });
  return out;
};

/**
 * The derived, rebuildable feed state in Redis (S26 C3, R-3, R-7, III.9): pushed timelines (ZSET, member = sortable item
 * id, score = milliseconds, so equal milliseconds order by id), the active marker, the completion marker, the
 * single-flight rebuild lock, celebrity recents and the followed-celebrity list. Every key has a TTL and the `fd:`
 * prefix; nothing is enumerated with `KEYS`/`SCAN`. Every call has a timeout; a failure, a timeout or a refusal is
 * `TimelineUnavailableError` (logged by class only), which callers turn into a degraded read or a retry.
 */
@Injectable()
export class RedisTimelineStore implements TimelineStore {
  private readonly logger = new Logger(RedisTimelineStore.name);

  constructor(
    @Inject(FEED_REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ApiConfigService,
  ) {}

  private async run<T>(call: (redis: Redis) => Promise<T>, multiplier = 1) {
    const timeoutMs = this.config.get('feed_timeline_timeout_ms') * multiplier;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        call(this.redis),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
    } catch (error) {
      this.logger.warn(`timeline call failed cause=${(error as Error).name}`);
      throw new TimelineUnavailableError();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private get activeTtl(): number {
    return this.config.get('feed_active_window_days') * 86_400;
  }

  async push(
    userIds: string[],
    entry: TimelineEntryRow,
    window: number,
  ): Promise<void> {
    if (!userIds.length) return;
    // pushes of a whole page share one round trip; the bound is generous because the page is large
    await this.run(async (redis) => {
      const pipeline = redis.pipeline();
      for (const userId of userIds)
        pipeline.eval(
          PUSH_TIMELINE,
          2,
          timelineKey(userId),
          timelineCompleteKey(userId),
          entry.ms,
          entry.itemId,
          window,
          FEED_TTL.tl,
        );
      const results = await pipeline.exec();
      const failed = results?.find(([error]) => error);
      if (failed) throw failed[0];
    }, 10);
  }

  async read(
    userId: string,
    before: TimelineEntryRow | null,
    limit: number,
  ): Promise<TimelineEntryRow[]> {
    return toEntries(
      await this.run((redis) =>
        redis.eval(
          RANK_PAGE,
          1,
          timelineKey(userId),
          before ? String(before.ms) : '',
          before?.itemId ?? '',
          limit,
        ),
      ),
    );
  }

  async activeAmong(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    return this.run(async (redis) => {
      const pipeline = redis.pipeline();
      for (const userId of userIds) pipeline.exists(activeKey(userId));
      const results = await pipeline.exec();
      const active = new Set<string>();
      results?.forEach(([error, value], i) => {
        if (error) throw error;
        if (value === 1) active.add(userIds[i]);
      });
      return active;
    }, 10);
  }

  async touchActive(userId: string): Promise<boolean> {
    const previous = await this.run((redis) =>
      redis.set(activeKey(userId), '1', 'EX', this.activeTtl, 'GET'),
    );
    return previous !== null;
  }

  async markActive(userId: string): Promise<void> {
    await this.run((redis) =>
      redis.set(activeKey(userId), '1', 'EX', this.activeTtl),
    );
  }

  async isComplete(userId: string): Promise<boolean> {
    return this.run(async (redis) => {
      const [marker, timeline] = await Promise.all([
        redis.get(timelineCompleteKey(userId)),
        redis.exists(timelineKey(userId)),
      ]);
      // a timeline lost while the marker survived (eviction) is incomplete too
      return marker === EMPTY_MARK || (marker === FULL_MARK && timeline === 1);
    });
  }

  async markComplete(userId: string, empty: boolean): Promise<void> {
    await this.run((redis) =>
      redis.set(
        timelineCompleteKey(userId),
        empty ? EMPTY_MARK : FULL_MARK,
        'EX',
        FEED_TTL.tlc,
      ),
    );
  }

  async invalidate(userId: string): Promise<void> {
    await this.run((redis) =>
      redis.del(timelineCompleteKey(userId), followedCelebritiesKey(userId)),
    );
  }

  async merge(
    userId: string,
    entries: TimelineEntryRow[],
    window: number,
  ): Promise<void> {
    await this.addEntries(timelineKey(userId), entries, window, FEED_TTL.tl);
  }

  /**
   * Additive: an entry that landed meanwhile is neither removed nor duplicated (ZADD of the same member is a no-op),
   * then the set is trimmed to `cap` and its expiry renewed, in one transaction.
   */
  private async addEntries(
    key: string,
    entries: TimelineEntryRow[],
    cap: number,
    ttl: number,
  ): Promise<void> {
    if (!entries.length) return;
    await this.run(async (redis) => {
      const args: Array<string | number> = [];
      for (const e of entries) args.push(e.ms, e.itemId);
      const results = await redis
        .multi()
        .zadd(key, ...args)
        .eval(
          `local over = redis.call('ZCARD', KEYS[1]) - tonumber(ARGV[1])
           if over > 0 then redis.call('ZREMRANGEBYRANK', KEYS[1], 0, over - 1) end
           redis.call('EXPIRE', KEYS[1], ARGV[2])
           return 1`,
          1,
          key,
          cap,
          ttl,
        )
        .exec();
      const failed = results?.find(([error]) => error);
      if (failed) throw failed[0];
    }, 5);
  }

  async acquireRebuild(userId: string): Promise<boolean> {
    return (
      (await this.run((redis) =>
        redis.set(rebuildLockKey(userId), '1', 'PX', FEED_TTL.rb * 1_000, 'NX'),
      )) === 'OK'
    );
  }

  async releaseRebuild(userId: string): Promise<void> {
    await this.run((redis) => redis.del(rebuildLockKey(userId)));
  }

  async pushRecent(
    authorId: string,
    entry: TimelineEntryRow,
    cap: number,
  ): Promise<void> {
    await this.run((redis) =>
      redis.eval(
        PUSH_IF_EXISTS,
        1,
        celebrityRecentsKey(authorId),
        entry.ms,
        entry.itemId,
        cap,
        FEED_TTL.cel,
      ),
    );
  }

  async recents(
    authorId: string,
    before: TimelineEntryRow | null,
    limit: number,
  ): Promise<TimelineEntryRow[] | null> {
    const flat = await this.run((redis) =>
      redis.eval(
        PAGE_IF_EXISTS,
        1,
        celebrityRecentsKey(authorId),
        before ? String(before.ms) : '',
        before?.itemId ?? '',
        limit,
      ),
    );
    return flat === null ? null : toEntries(flat);
  }

  async putRecents(
    authorId: string,
    entries: TimelineEntryRow[],
    cap: number,
  ): Promise<void> {
    await this.addEntries(
      celebrityRecentsKey(authorId),
      entries,
      cap,
      FEED_TTL.cel,
    );
  }

  async followedCelebrities(userId: string): Promise<string[] | null> {
    const raw = await this.run((redis) =>
      redis.get(followedCelebritiesKey(userId)),
    );
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      return null;
    }
  }

  async setFollowedCelebrities(
    userId: string,
    accountIds: string[],
  ): Promise<void> {
    await this.run((redis) =>
      redis.set(
        followedCelebritiesKey(userId),
        JSON.stringify(accountIds),
        'EX',
        FEED_TTL.cf,
      ),
    );
  }
}
