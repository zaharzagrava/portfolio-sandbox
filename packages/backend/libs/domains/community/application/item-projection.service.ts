import { Inject, Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { TimeIdGenerator, type RandomSource } from '../domain/ids';
import {
  auctionItem,
  postItem,
  productItem,
  type ItemDecision,
  type ItemDraft,
  type PostCreatedInput,
  type ProductEventInput,
  type ProductEventKind,
} from '../domain/item-rules';
import {
  FEED_ITEM_STORE,
  FEED_RANDOM_BYTES,
  PRODUCT_COPY_STORE,
  type FeedItemStore,
  type ProductCopyStore,
} from '../domain/ports';
import { feedItemCounter } from '../domain/feed-metrics';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ItemOutcome = 'created' | 'duplicate' | 'skipped';

/**
 * Source event to feed item (S26 B1, B3, B4, R-4, R-6). The product copy is `community`'s own (R3): the catalog's tables
 * are never read. The order inside a product event is decide, store the item, then move the copy forward: a crash in
 * between is repaired by the redelivered event (it decides the same way, finds the claim and reuses its item). Permanent
 * errors dead-letter after the consumer's attempt budget; store failures are transient and retried by the framework.
 */
@Injectable()
export class ItemProjectionService {
  private readonly ids: TimeIdGenerator;

  constructor(
    @Inject(FEED_ITEM_STORE) private readonly items: FeedItemStore,
    @Inject(PRODUCT_COPY_STORE) private readonly copies: ProductCopyStore,
    @Inject(FEED_RANDOM_BYTES) random: RandomSource,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {
    this.ids = new TimeIdGenerator(random);
  }

  async applyProduct(
    kind: ProductEventKind,
    event: ProductEventInput & { title: string },
    occurredAt: Date,
  ): Promise<ItemOutcome> {
    const previous = await this.copies.get(event.productId);
    const outcome = await this.decide(
      productItem(kind, event, previous),
      occurredAt,
    );
    await this.copies.apply(
      {
        kind: 'snapshot',
        copy: {
          productId: event.productId,
          shopId: event.shopId,
          title: event.title,
          priceMinor: event.priceMinor,
          currency: event.currency,
          status: event.status,
          isSandbox: event.isSandbox,
          productVersion: event.productVersion,
        },
      },
      this.clock.now(),
    );
    return outcome;
  }

  async applyProductDeleted(event: {
    productId: string;
    shopId: string;
    productVersion: number;
  }): Promise<void> {
    await this.copies.apply({ kind: 'deleted', ...event }, this.clock.now());
  }

  async postCreated(
    event: PostCreatedInput,
    occurredAt: Date,
  ): Promise<ItemOutcome> {
    this.assertPostId(event.postId);
    const tombstoned = await this.copies.isPostDeleted(event.postId);
    return this.decide(postItem(event, tombstoned), occurredAt);
  }

  async postDeleted(postId: string): Promise<void> {
    this.assertPostId(postId);
    await this.copies.tombstonePost(postId, this.clock.now());
  }

  async auction(
    kind: 'created' | 'opened',
    event: Parameters<typeof auctionItem>[1],
    occurredAt: Date,
  ): Promise<ItemOutcome> {
    const product = await this.copies.get(event.productId);
    return this.decide(auctionItem(kind, event, product), occurredAt);
  }

  private assertPostId(postId: string): void {
    if (!UUID.test(postId)) throw new PermanentError('invalid_post_id');
  }

  private async decide(
    decision: ItemDecision,
    occurredAt: Date,
  ): Promise<ItemOutcome> {
    if (decision.action === 'retry')
      // the product's own event has not been consumed yet: the framework retries, then dead-letters (FR-025)
      throw new PermanentError(decision.reason);
    if (decision.action === 'skip') return 'skipped';
    return this.store(decision.draft, occurredAt);
  }

  private async store(
    draft: ItemDraft,
    occurredAt: Date,
  ): Promise<ItemOutcome> {
    const { created } = await this.items.store(
      {
        itemId: this.ids.next(occurredAt),
        authorId: draft.authorId,
        kind: draft.kind,
        title: draft.title,
        payload: draft.payload,
        createdAt: occurredAt,
        productId: draft.productId,
        shopId: draft.shopId,
        postId: draft.postId,
      },
      draft.sourceKey,
      {
        claimTtlSeconds: draft.claimTtlSeconds,
        ttlSeconds: this.config.get('feed_retention_days') * 86_400,
        now: this.clock.now(),
      },
    );
    feedItemCounter.add(1, {
      kind: draft.kind,
      outcome: created ? 'created' : 'duplicate',
    });
    return created ? 'created' : 'duplicate';
  }
}
