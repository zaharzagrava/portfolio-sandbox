import { Inject, Injectable } from '@nestjs/common';
import type { DigitalProductLink } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ProductQueryService } from '@app/domains/catalog';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  assetNotFound,
  digitalLinkNotFound,
  digitalProductSold,
  productNotFound,
} from '../domain/errors';
import {
  ASSETS,
  DIGITAL,
  ENTITLEMENTS,
  type AssetRepository,
  type DigitalRepository,
  type EntitlementRepository,
} from '../domain/ports';
import {
  DigitalProductLinked,
  DigitalProductUnlinked,
} from './events/asset-events';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fileNameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The link between a product and a file (S31 FR-039). The product is the catalog's: it is checked through the exported
 * batch lookup with the shop ID, never by SQL on its table (FR-054). The link, the entitlements it moves and the outbox
 * event commit together.
 */
@Injectable()
export class DigitalService {
  constructor(
    @Inject(ASSETS) private readonly assets: AssetRepository,
    @Inject(DIGITAL) private readonly digital: DigitalRepository,
    @Inject(ENTITLEMENTS) private readonly entitlements: EntitlementRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly products: ProductQueryService,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {}

  /** `PUT`: links, or re-links (active entitlements follow in the same transaction); a repeat changes nothing. */
  async link(
    shopId: string,
    productId: string,
    assetId: string,
  ): Promise<void> {
    if (!UUID.test(productId)) throw productNotFound();
    const found = await this.products.getProductsByIds([productId], { shopId });
    if (!found.has(productId)) throw productNotFound();
    const now = this.clock.now();
    await this.transactions.run(async () => {
      const asset = await this.assets.lock(shopId, assetId);
      if (!asset || asset.status !== 'ACTIVE') throw assetNotFound();
      const existing = await this.digital.lockLink(productId);
      if (existing && existing.assetId === assetId) return;
      await this.digital.upsertLink({ productId, shopId, assetId, now });
      if (existing) await this.entitlements.moveToAsset(productId, assetId);
      await this.outbox.append(
        DigitalProductLinked.create(productId, now.getTime(), {
          productId,
          shopId,
          assetId,
          linkedAt: now.toISOString(),
        }),
      );
    });
  }

  async get(shopId: string, productId: string): Promise<DigitalProductLink> {
    if (!UUID.test(productId)) throw digitalLinkNotFound();
    const view = await this.digital.view(shopId, productId);
    if (!view) throw digitalLinkNotFound();
    return {
      productId,
      assetId: view.assetId,
      fileName: fileNameOf(view.path),
      sizeBytes: view.sizeBytes,
      version: view.version,
      linkedAt: view.linkedAt.toISOString(),
    };
  }

  /** `DELETE`: refused while any entitlement exists, so a buyer keeps what they paid for. */
  async unlink(shopId: string, productId: string): Promise<void> {
    if (!UUID.test(productId)) throw digitalLinkNotFound();
    const now = this.clock.now();
    await this.transactions.run(async () => {
      const existing = await this.digital.lockLink(productId);
      if (!existing || existing.shopId !== shopId) throw digitalLinkNotFound();
      if (await this.entitlements.anyOfProduct(productId))
        throw digitalProductSold();
      await this.digital.deleteLink(productId);
      await this.outbox.append(
        DigitalProductUnlinked.create(productId, now.getTime(), {
          productId,
          shopId,
          assetId: existing.assetId,
          unlinkedAt: now.toISOString(),
        }),
      );
    });
  }
}
