import { Injectable } from '@nestjs/common';
import { ShopQueryService } from '@app/domains/tenancy';
import type { ShopSummary, ShopSummaryPort } from '../domain/payout-ports';

const BATCH = 200;

/**
 * Shop facts for the payout gates through tenancy's R1 service (S03 follow-up): batches of at most 200 ids, and only
 * `status` and `payoutsEnabled` leave this class. An id missing from the answer is unknown to tenancy.
 */
@Injectable()
export class TenancyShopSummaryAdapter implements ShopSummaryPort {
  constructor(private readonly shops: ShopQueryService) {}

  async getSummaries(shopIds: string[]): Promise<Map<string, ShopSummary>> {
    const out = new Map<string, ShopSummary>();
    const unique = [...new Set(shopIds)];
    for (let i = 0; i < unique.length; i += BATCH) {
      const found = await this.shops.getShopsByIds(unique.slice(i, i + BATCH));
      for (const [id, shop] of found)
        out.set(id, {
          status: shop.status,
          payoutsEnabled: shop.payoutsEnabled,
        });
    }
    return out;
  }
}
