import { Inject, Injectable, Logger } from '@nestjs/common';
import { chatBackfillSkippedCounter } from '../domain/chat-metrics';
import {
  PORTS,
  type ProductLookup,
  type ShopBackfillRepository,
  type ShopProvisioner,
} from '../domain/ports';

/** The batch limit of the S03 provisioning call (`ensureShopsForLegacySellers`) and of this job. */
export const BACKFILL_BATCH = 200;

export interface BackfillBatch {
  updated: number;
  skipped: number;
  /** The last channel id looked at: the next batch continues after it, so a skipped channel does not loop. */
  lastId: string | null;
  /** How many channels this batch looked at (0: nothing is left to look at). */
  looked: number;
}

export interface BackfillRun {
  updated: number;
  skipped: number;
  remaining: number;
}

/**
 * Channels created before shops existed receive their shop (S24 FR-044, R-12): the product's shop from the catalog
 * (`getProductsByIds`), or, for a product that predates shops, the shop provisioned for the channel's seller by tenancy
 * (`ensureShopsForLegacySellers`). A channel whose product is gone is left for review (counted and logged) and skipped:
 * it never stops the batch. Repeatable: a channel with a shop is not looked at again. When none is left without one the
 * store makes the shop required.
 */
@Injectable()
export class ChatShopBackfillService {
  private readonly log = new Logger(ChatShopBackfillService.name);

  constructor(
    @Inject(PORTS.ShopBackfillRepository)
    private readonly repo: ShopBackfillRepository,
    @Inject(PORTS.ProductLookup) private readonly products: ProductLookup,
    @Inject(PORTS.ShopProvisioner)
    private readonly provisioner: ShopProvisioner,
  ) {}

  async runBatch(afterId: string | null = null): Promise<BackfillBatch> {
    const channels = await this.repo.unassigned(afterId, BACKFILL_BATCH);
    if (channels.length === 0)
      return { updated: 0, skipped: 0, lastId: afterId, looked: 0 };

    const found = await this.products.findMany([
      ...new Set(channels.map((c) => c.productId)),
    ]);
    const needsSeller = [
      ...new Set(
        channels
          .filter(
            (c) => found.has(c.productId) && !found.get(c.productId)!.shopId,
          )
          .map((c) => c.sellerId),
      ),
    ];
    const provisioned = needsSeller.length
      ? await this.provisioner.ensureForSellers(needsSeller)
      : new Map<string, string>();

    let updated = 0;
    let skipped = 0;
    for (const channel of channels) {
      const product = found.get(channel.productId);
      const shopId = product
        ? (product.shopId ?? provisioned.get(channel.sellerId))
        : undefined;
      if (!shopId) {
        skipped += 1;
        chatBackfillSkippedCounter.add(1);
        this.log.warn(
          `channel ${channel.id} has no product or seller shop to take: left for review`,
        );
        continue;
      }
      if (await this.repo.assign(channel.id, shopId)) updated += 1;
    }
    return {
      updated,
      skipped,
      lastId: channels[channels.length - 1].id,
      looked: channels.length,
    };
  }

  /** Batches until nothing is left to look at; then, if every channel has a shop, makes it required. */
  async run(): Promise<BackfillRun> {
    let updated = 0;
    let skipped = 0;
    let after: string | null = null;
    for (;;) {
      const batch = await this.runBatch(after);
      if (batch.looked === 0) break;
      updated += batch.updated;
      skipped += batch.skipped;
      after = batch.lastId;
    }
    await this.repo.requireShop();
    return { updated, skipped, remaining: await this.repo.remaining() };
  }
}
