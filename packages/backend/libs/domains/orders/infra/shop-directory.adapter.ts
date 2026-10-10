import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { ShopQueryService } from '@app/domains/tenancy';
import type { ShopDirectoryPort, ShopSummary } from '../domain/ports';
import { UpstreamUnavailableError } from '../domain/order-errors';
import { withTimeout } from './with-timeout';

const MAX_SHOPS_PER_CALL = 50;

/** Status and sandbox flag of the shops in a cart (S03 R1), at most 50 per call. */
@Injectable()
export class ShopDirectoryAdapter implements ShopDirectoryPort {
  constructor(
    private readonly shops: ShopQueryService,
    private readonly config: ApiConfigService,
  ) {}

  async getShops(ids: string[]): Promise<Map<string, ShopSummary>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, ShopSummary>();
    for (let i = 0; i < unique.length; i += MAX_SHOPS_PER_CALL) {
      const found = await withTimeout(
        this.shops.getShopsByIds(unique.slice(i, i + MAX_SHOPS_PER_CALL)),
        this.config.get('orders_shops_timeout_ms'),
        () => new UpstreamUnavailableError('shops'),
      );
      for (const [id, s] of found)
        out.set(id, { id, status: s.status, isSandbox: s.isSandbox });
    }
    return out;
  }
}
