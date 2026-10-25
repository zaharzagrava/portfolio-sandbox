import { Inject, Injectable } from '@nestjs/common';
import type {
  GalleryMember,
  GalleryPublic,
  GalleryPutRequest,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ProductQueryService } from '@app/domains/catalog';
import { ShopQueryService } from '@app/domains/tenancy';
import {
  mediaNotAttachable,
  productArchived,
  productNotFound,
  versionConflict,
} from '../domain/media-errors';
import { toUrls } from '../domain/media-urls';
import { GalleryRow, MediaStore } from '../domain/ports';
import { MEDIA_ORIGIN } from '../media.constants';

/**
 * Product galleries (S29 FR-040–FR-045): ordered, versioned, replaced whole by one `PUT`. The product comes from S05 (R1
 * `getProductsByIds`, once per request and before the transaction: no network call inside it), the shop's state from S03;
 * `media` never reads their tables. The version row is locked `FOR UPDATE`, so two writers with the same
 * `expectedVersion` cannot both win.
 */
@Injectable()
export class GalleryService {
  constructor(
    private readonly store: MediaStore,
    private readonly products: ProductQueryService,
    private readonly shops: ShopQueryService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MEDIA_ORIGIN) private readonly origin: string,
  ) {}

  private items(rows: GalleryRow[]): GalleryPublic['items'] {
    return rows.map((row) => ({
      mediaId: row.mediaId,
      position: row.position,
      urls: toUrls(row.variants, this.origin),
      width: row.width,
      height: row.height,
    }));
  }

  /** The product of this shop, from R1; a missing or foreign product is the same `404`. */
  private async ownProduct(shopId: string, productId: string) {
    const product = (
      await this.products.getProductsByIds([productId], { shopId })
    ).get(productId.toLowerCase());
    if (!product) throw productNotFound();
    return product;
  }

  async replace(
    shopId: string,
    productId: string,
    body: GalleryPutRequest,
  ): Promise<GalleryMember> {
    const product = await this.ownProduct(shopId, productId);
    if (product.status === 'ARCHIVED') throw productArchived();

    const now = this.clock.now();
    await this.store.tx(async ({ gallery }) => {
      const version = await gallery.lockVersion(product.id, shopId, now);
      if (version !== body.expectedVersion) throw versionConflict(version);
      const failures = await gallery.classify(body.mediaIds, shopId);
      if (failures.length > 0) throw mediaNotAttachable(failures);
      const current = await gallery.currentIds(product.id);
      const same =
        current.length === body.mediaIds.length &&
        current.every((id, index) => id === body.mediaIds[index]);
      if (same) return; // nothing to write, nothing to publish
      await gallery.replace({
        productId: product.id,
        shopId,
        mediaIds: body.mediaIds,
        version,
        now,
      });
    });
    return this.read(product.id);
  }

  /** Member read: any role with `products.read` (checked by `ShopScoped`), also for an archived product. */
  async memberRead(shopId: string, productId: string): Promise<GalleryMember> {
    const product = await this.ownProduct(shopId, productId);
    return this.read(product.id);
  }

  /** Public read: only while the product is visible (ACTIVE, not sandbox, shop ACTIVE and not sandbox). */
  async publicRead(productId: string): Promise<GalleryPublic> {
    const product = (await this.products.getProductsByIds([productId])).get(
      productId.toLowerCase(),
    );
    if (!product || product.status !== 'ACTIVE' || product.isSandbox)
      throw productNotFound();
    const shop = (await this.shops.getShopsByIds([product.shopId])).get(
      product.shopId,
    );
    if (!shop || shop.status !== 'ACTIVE' || shop.isSandbox)
      throw productNotFound();
    return {
      items: this.items(await this.store.gallery.readItems(product.id)),
    };
  }

  private async read(productId: string): Promise<GalleryMember> {
    const { items, version } = await this.store.gallery.readSnapshot(productId);
    return { items: this.items(items), version };
  }
}
