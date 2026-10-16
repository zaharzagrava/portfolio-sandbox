import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  feedPayloadSchemas,
  type FeedItemView,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { fromSortableId } from '../domain/ids';
import type { TimelineEntry } from '../domain/merge';
import type { ProductCopy } from '../domain/version-guard';
import {
  FEED_ITEM_STORE,
  FEED_POST_LOOKUP,
  FEED_SHOP_DIRECTORY,
  PRODUCT_COPY_STORE,
  type FeedItemStore,
  type FeedPostLookup,
  type FeedShopDirectory,
  type ProductCopyStore,
  type StoredFeedItem,
} from '../domain/ports';
import { withTimeout } from '../domain/with-timeout';

export interface Hydrated {
  /** The visible items, in the order of the entries asked for. */
  items: FeedItemView[];
  /** A source could not be read: the items that depend on it are left out of this response. */
  degraded: boolean;
}

const authorType = (authorId: string): 'shop' | 'user' =>
  authorId.startsWith('shop:') ? 'shop' : 'user';

/** The answer of one source: its data, or `null` when it failed or ran out of time. */
type Answer<T> = T | null;

/**
 * Builds the page items from candidate entries (S26 D5, D6). One batch read of the stored items, then one batch per
 * source, in parallel, each under its own timeout: product copies (own store), shops (S03, one call with every distinct
 * shop) and posts (S25, one call per 100 distinct posts). Visibility fails closed: an item is shown only when everything
 * that decides it is known and says yes (author still followed; the shop `ACTIVE`; a product copy `ACTIVE` and not
 * sandbox; the post still returned by S25). When a source cannot be read the items that depend on it are left out of
 * this response and the page is `degraded`; independent items are still served. A store of our own that fails is not
 * degraded, it is `503 feed_unavailable` (thrown by the store).
 */
@Injectable()
export class FeedHydrationService {
  private readonly logger = new Logger(FeedHydrationService.name);

  constructor(
    @Inject(FEED_ITEM_STORE) private readonly items: FeedItemStore,
    @Inject(PRODUCT_COPY_STORE) private readonly copies: ProductCopyStore,
    @Inject(FEED_SHOP_DIRECTORY) private readonly shops: FeedShopDirectory,
    @Inject(FEED_POST_LOOKUP) private readonly posts: FeedPostLookup,
    private readonly config: ApiConfigService,
  ) {}

  async hydrate(
    entries: TimelineEntry[],
    followed: ReadonlySet<string>,
  ): Promise<Hydrated> {
    if (!entries.length) return { items: [], degraded: false };
    const stored = new Map<string, StoredFeedItem>(
      (
        await this.items.getMany(entries.map((e) => fromSortableId(e.itemId)))
      ).map((i) => [i.itemId, i]),
    );
    const rows = entries
      .map((e) => stored.get(fromSortableId(e.itemId)))
      .filter((r): r is StoredFeedItem => !!r && followed.has(r.authorId));

    const distinct = (values: Array<string | null>) => [
      ...new Set(values.filter((v): v is string => !!v)),
    ];
    const productIds = distinct(rows.map((r) => r.productId));
    const shopIds = distinct(
      rows
        .filter((r) => authorType(r.authorId) === 'shop')
        .map((r) => r.authorId.slice('shop:'.length)),
    );
    const postIds = distinct(
      rows.filter((r) => r.kind === 'post').map((r) => r.postId),
    );

    const [copies, shops, posts] = await Promise.all([
      productIds.length
        ? this.copies.getMany(productIds)
        : Promise.resolve(new Map<string, ProductCopy>()),
      this.source('shops', shopIds, (ids) => this.shops.lookup(ids)),
      this.source('posts', postIds, (ids) => this.posts.lookup(ids)),
    ]);
    const degraded = shops === null || posts === null;

    const views: FeedItemView[] = [];
    for (const row of rows) {
      const type = authorType(row.authorId);
      let name: string | null = null;
      if (type === 'shop') {
        const shop = shops?.get(row.authorId.slice('shop:'.length));
        if (!shop || shop.status !== 'ACTIVE') continue;
        name = shop.name;
      }
      if (row.productId) {
        const copy = copies.get(row.productId);
        if (!copy || copy.status !== 'ACTIVE' || copy.isSandbox) continue;
      }
      if (row.kind === 'post' && !(row.postId && posts?.get(row.postId)))
        continue;
      const payload = feedPayloadSchemas[row.kind]?.safeParse(row.payload);
      if (!payload?.success) continue;
      views.push({
        itemId: row.itemId,
        kind: row.kind,
        author: { accountId: row.authorId, type, name },
        title: row.title,
        payload: payload.data,
        createdAt: row.createdAt.toISOString(),
      } as FeedItemView);
    }
    return { items: views, degraded };
  }

  /** One batch to a source owned by another capability; a failure is logged by source and class only. */
  private async source<V>(
    name: 'shops' | 'posts',
    ids: string[],
    call: (ids: string[]) => Promise<Map<string, V>>,
  ): Promise<Answer<Map<string, V>>> {
    if (!ids.length) return new Map<string, V>();
    try {
      return await withTimeout(
        call(ids),
        this.config.get('feed_hydration_timeout_ms'),
        () => new Error('timeout'),
      );
    } catch (error) {
      this.logger.warn(
        `hydration source failed source=${name} cause=${(error as Error).name}`,
      );
      return null;
    }
  }
}
