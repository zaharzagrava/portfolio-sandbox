import { Injectable } from '@nestjs/common';
import { ShopQueryService } from '@app/domains/tenancy';
import type { ShopStatusGateway, ShopStatusView } from '../domain/ports';

/** Tenancy facts through `ShopQueryService.getShopsByIds` (R1) only. */
@Injectable()
export class TenancyShopStatusGateway implements ShopStatusGateway {
  constructor(private readonly shops: ShopQueryService) {}

  async getStatuses(shopIds: string[]): Promise<Map<string, ShopStatusView>> {
    const found = await this.shops.getShopsByIds(shopIds);
    return new Map(
      [...found].map(([id, s]) => [
        id,
        { status: s.status, isSandbox: s.isSandbox },
      ]),
    );
  }
}
