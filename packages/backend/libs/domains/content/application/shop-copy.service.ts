import { Inject, Injectable } from '@nestjs/common';
import { TransactionRunner } from '@app/infrastructure/context';
import { LIMITS } from '../domain/limits';
import {
  SHOP_COPY_REPOSITORY,
  STORY_REPOSITORY,
  type ShopCopyRepository,
  type ShopStatus,
  type StoryRepository,
} from '../domain/ports';
import { CacheInvalidationService } from './cache-invalidation.service';
import { storyMetrics } from './story-metrics';

/** A story of a shop is public while its copy says so; `DELETING` keeps its live stories until `shop_deleted` (S03). */
export const isPubliclyVisible = (status: ShopStatus): boolean =>
  status === 'ACTIVE' || status === 'DELETING';

/** Stories removed per batch of a shop purge. */
const PURGE_STORIES_PER_BATCH = LIMITS.purgeBatch / 10;

/**
 * The shop copy and what follows from it (S27 FR-062, FR-063, AS-58, AS-97, AS-98): tenancy events are merged into
 * `StoryShop` forward only; a change of visibility clears the origin entries of the shop's stories and purges the
 * `shop:<id>` tag; a deleted shop's content is removed in bounded batches. Every step is repeatable.
 */
@Injectable()
export class ShopCopyService {
  constructor(
    @Inject(SHOP_COPY_REPOSITORY) private readonly copies: ShopCopyRepository,
    @Inject(STORY_REPOSITORY) private readonly stories: StoryRepository,
    private readonly invalidation: CacheInvalidationService,
    private readonly transactions: TransactionRunner,
  ) {}

  /** `shop_created` / `shop_updated`: the slug (set once) and the version. */
  async onIdentity(input: {
    shopId: string;
    slug: string;
    shopVersion: number;
  }): Promise<void> {
    const applied = await this.copies.upsertGuarded({
      shopId: input.shopId,
      slug: input.slug,
      status: null,
      shopVersion: input.shopVersion,
    });
    storyMetrics.shopCopy.add(1, { result: applied ? 'applied' : 'ignored' });
  }

  /** `shop_status_changed`, the copy part: the status moves forward only. `true` when the event changed the copy. */
  async applyStatus(input: {
    shopId: string;
    to: ShopStatus;
    shopVersion: number;
  }): Promise<boolean> {
    const applied = await this.copies.upsertGuarded({
      shopId: input.shopId,
      slug: null,
      status: input.to,
      shopVersion: input.shopVersion,
    });
    storyMetrics.shopCopy.add(1, { result: applied ? 'applied' : 'ignored' });
    return applied;
  }

  /**
   * `shop_status_changed`, the cache part: when the shop became public or stopped being public, the origin entries of
   * its stories are cleared and the `shop:<id>` tag is purged at the CDN and the front end (AS-58).
   */
  async clearForStatusChange(input: {
    shopId: string;
    from: ShopStatus;
    to: ShopStatus;
    eventId: string;
  }): Promise<void> {
    if (isPubliclyVisible(input.from) === isPubliclyVisible(input.to)) return;
    const copy = await this.copies.find(input.shopId);
    if (copy?.slug) {
      let after: string | undefined;
      for (;;) {
        const page = await this.stories.publishedSlugs(
          input.shopId,
          LIMITS.purgeBatch,
          after,
        );
        if (page.length === 0) break;
        for (const story of page)
          await this.invalidation.clearOrigin(copy.slug, story.slug);
        after = page[page.length - 1].id;
      }
    }
    await this.invalidation.purge(
      this.invalidation.batches([
        { eventId: input.eventId, tags: [`shop:${input.shopId}`] },
      ]),
    );
  }

  /** `shop_deleted`: stories, drafts, versions, history and the copy go; caches are cleared first, batch by batch. */
  async onDeleted(shopId: string, eventId: string): Promise<void> {
    const copy = await this.copies.find(shopId);
    for (;;) {
      const slugs = await this.transactions.run(() =>
        this.copies.purgeBatch(shopId, PURGE_STORIES_PER_BATCH),
      );
      if (slugs.length === 0) break;
      if (copy?.slug)
        for (const slug of slugs)
          await this.invalidation.clearOrigin(copy.slug, slug);
    }
    await this.invalidation.purge(
      this.invalidation.batches([{ eventId, tags: [`shop:${shopId}`] }]),
    );
    await this.copies.deleteCopy(shopId);
    storyMetrics.shopCopy.add(1, { result: 'purged' });
  }
}
