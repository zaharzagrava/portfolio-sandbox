import { Injectable, Logger } from '@nestjs/common';
import { SecretBox } from '@app/domains/identity';
import { WidgetSiteRepository, WidgetShops } from '../domain/widget-ports';
import { secretContext } from '../application/widget-sites.service';

const BATCH = 500;

export interface BackfillResult {
  scanned: number;
  resealed: number;
  shopCopies: number;
}

/**
 * The one-off, idempotent and resumable backfill of data-model.md step 2 (G-09, G-14, G-21), run between the expand and
 * the contract migration (never inside a migration transaction):
 *  1. identity secrets sealed before the site-bound context existed (`v1`) are re-sealed with `widget-site:<id>`; the
 *     update is conditional on the sealed value it read, so a concurrent rotation is never overwritten;
 *  2. the shop copy (name, status, version) of every site whose `shopVersion` is still 0 is read through
 *     `ShopQueryService.getShopsByIds` in batches of at most 500 and applied with the same version guard the events use.
 * A second run changes nothing. `afterId` resumes after the last site a failed run saw.
 */
@Injectable()
export class WidgetBackfill {
  private readonly log = new Logger('WidgetBackfill');

  constructor(
    private readonly sites: WidgetSiteRepository,
    private readonly shops: WidgetShops,
    private readonly box: SecretBox,
  ) {}

  async run(afterId: string | null = null): Promise<BackfillResult> {
    const result: BackfillResult = { scanned: 0, resealed: 0, shopCopies: 0 };
    let cursor = afterId;
    for (;;) {
      const page = await this.sites.backfillPage(cursor, BATCH);
      if (page.length === 0) break;
      for (const site of page) {
        result.scanned += 1;
        if (site.identitySecretSealed.startsWith('v1.')) {
          const plain = this.box.open(site.identitySecretSealed);
          const sealed = this.box.seal(plain, secretContext(site.id));
          if (
            await this.sites.resealIf(
              site.id,
              site.identitySecretSealed,
              sealed,
            )
          )
            result.resealed += 1;
        }
      }
      const unset = page.filter((s) => s.shopVersion === 0);
      if (unset.length > 0) {
        const found = await this.shops.getShops([
          ...new Set(unset.map((s) => s.shopId)),
        ]);
        for (const [shopId, shop] of found) {
          const changed = await this.sites.applyShopCopy(shopId, {
            shopVersion: shop.shopVersion,
            name: shop.name,
            status: shop.status,
          });
          result.shopCopies += changed.length;
        }
      }
      cursor = page[page.length - 1].id;
      this.log.log(`backfill at ${cursor}: ${JSON.stringify(result)}`);
    }
    return result;
  }
}
