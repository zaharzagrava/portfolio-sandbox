import { Injectable } from '@nestjs/common';
import {
  ShopProvisioningService,
  ShopQueryService,
} from '@app/domains/tenancy';
import { ShopDirectory, ShopFacts } from '../domain/ports';

/** The tenancy capability through its exported services only (R1, S03 follow-up): no `Shop` model, no SQL on its tables. */
@Injectable()
export class TenancyShopDirectory extends ShopDirectory {
  constructor(
    private readonly provisioning: ShopProvisioningService,
    private readonly shops: ShopQueryService,
  ) {
    super();
  }

  async sandboxShopOf(liveShopId: string): Promise<string> {
    return (await this.provisioning.ensureSandboxShop(liveShopId)).id;
  }

  async getShops(ids: string[]): Promise<Map<string, ShopFacts>> {
    const found = await this.shops.getShopsByIds(ids);
    return new Map(
      [...found].map(([id, s]) => [
        id,
        {
          id,
          name: s.name,
          slug: s.slug,
          status: s.status,
          isSandbox: s.isSandbox,
        },
      ]),
    );
  }
}
