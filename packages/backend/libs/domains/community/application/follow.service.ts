import { Inject, Injectable } from '@nestjs/common';
import {
  FEED_ACCOUNT_ID_PATTERN,
  type FollowStatus,
  type FollowingPage,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import type { FeedCursorCodec } from '../domain/feed-cursor';
import {
  accountNotFound,
  cannotFollowSelf,
  feedValidationFailed,
  followingLimitReached,
  invalidFeedCursor,
} from '../domain/feed-errors';
import {
  CELEBRITY_STORE,
  FEED_ACCOUNT_DIRECTORY,
  FEED_CURSOR_CODEC,
  FEED_SHOP_DIRECTORY,
  FOLLOW_CACHE_INVALIDATOR,
  FOLLOW_GRAPH_STORE,
  type CelebrityStore,
  type FeedAccountDirectory,
  type FeedShopDirectory,
  type FollowCacheInvalidator,
  type FollowGraphStore,
} from '../domain/ports';

export const FOLLOWING_DEFAULT_LIMIT = 50;
export const FOLLOWING_MAX_LIMIT = 100;
export const FOLLOW_STATUS_MAX_IDS = 100;

/** Shops that may be followed: a suspended shop is still a shop; one that is closing or gone is not. */
const FOLLOWABLE_SHOP_STATUSES = new Set(['ACTIVE', 'SUSPENDED']);

interface Target {
  type: 'shop' | 'user';
  id: string;
}

function parseAccountId(accountId: string, field: string): Target {
  if (!FEED_ACCOUNT_ID_PATTERN.test(accountId))
    throw feedValidationFailed([field]);
  const [type, id] = accountId.split(':');
  return { type: type as Target['type'], id };
}

/**
 * Follow, unfollow, list and status (S26 US1, FR-001..FR-008). The decision of every transition belongs to the follow
 * graph store (one conditional write); this service validates the target through the owners' exported directories
 * (S03, S01), applies the limit and invalidates the derived timeline state a change makes stale (A9).
 */
@Injectable()
export class FollowService {
  constructor(
    @Inject(FOLLOW_GRAPH_STORE) private readonly graph: FollowGraphStore,
    @Inject(FEED_SHOP_DIRECTORY) private readonly shops: FeedShopDirectory,
    @Inject(FEED_ACCOUNT_DIRECTORY)
    private readonly users: FeedAccountDirectory,
    @Inject(FOLLOW_CACHE_INVALIDATOR)
    private readonly cache: FollowCacheInvalidator,
    @Inject(CELEBRITY_STORE) private readonly celebrities: CelebrityStore,
    @Inject(FEED_CURSOR_CODEC) private readonly cursors: FeedCursorCodec,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  async follow(userId: string, accountId: string): Promise<void> {
    const target = parseAccountId(accountId, 'accountId');
    if (target.type === 'user' && target.id === userId)
      throw cannotFollowSelf();
    await this.assertFollowable(target);

    const limit = this.config.get('feed_following_limit');
    const outcome = await this.graph.follow(
      userId,
      accountId,
      limit,
      this.clock.now(),
    );
    if (outcome === 'limit_reached') throw followingLimitReached(limit);
    // also on a replay: a request that failed after the write is healed by its retry
    await this.cache.invalidate(userId);
    await this.promoteWhenDue(accountId);
  }

  /** Reaching the celebrity threshold promotes the account for good (C1, AS-24); also checked by fan-out. */
  private async promoteWhenDue(accountId: string): Promise<void> {
    const threshold = this.config.get('feed_celebrity_threshold');
    const count = await this.graph.followerCount(accountId);
    if (count >= threshold)
      await this.celebrities.promote(accountId, count, this.clock.now());
  }

  async unfollow(userId: string, accountId: string): Promise<void> {
    parseAccountId(accountId, 'accountId');
    await this.graph.unfollow(userId, accountId, this.clock.now());
    await this.cache.invalidate(userId);
  }

  async following(
    userId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<FollowingPage> {
    const after =
      cursor === undefined ? null : this.cursors.decodeFollowing(cursor);
    if (cursor !== undefined && !after) throw invalidFeedCursor();

    const edges = await this.graph.list(userId, after, limit + 1);
    const page = edges.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((e) => ({
        accountId: e.accountId,
        followedAt: e.followedAt.toISOString(),
      })),
      nextCursor:
        edges.length > limit && last
          ? this.cursors.encodeFollowing({
              followedAtMs: last.followedAt.getTime(),
              accountId: last.accountId,
            })
          : null,
    };
  }

  /** One entry per distinct requested id, in request order. */
  async status(userId: string, accountIds: string[]): Promise<FollowStatus> {
    if (!accountIds.length || accountIds.length > FOLLOW_STATUS_MAX_IDS)
      throw feedValidationFailed(['accountIds']);
    for (const id of accountIds) parseAccountId(id, 'accountIds');
    return this.graph.status(userId, [...new Set(accountIds)]);
  }

  private async assertFollowable(target: Target): Promise<void> {
    if (target.type === 'shop') {
      const shop = (await this.shops.lookup([target.id])).get(target.id);
      if (!shop || !FOLLOWABLE_SHOP_STATUSES.has(shop.status))
        throw accountNotFound();
      return;
    }
    if (!(await this.users.existing([target.id])).has(target.id))
      throw accountNotFound();
  }
}
