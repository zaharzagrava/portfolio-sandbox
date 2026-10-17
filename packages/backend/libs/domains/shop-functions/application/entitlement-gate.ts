import { Inject, Injectable } from '@nestjs/common';
import { Domain_EntitlementRequiredError } from '@app/domains/billing';
import {
  SHOP_FUNCTIONS_ENTITLEMENTS,
  type ShopFunctionsEntitlements,
} from '../domain/ports';

export const SHOP_FUNCTIONS_FEATURE = 'shopFunctions';

/** The write routes' entitlement check (S45 FR-003): `403 entitlement_required {feature}`; reads, disable and delete skip it. */
@Injectable()
export class EntitlementGate {
  constructor(
    @Inject(SHOP_FUNCTIONS_ENTITLEMENTS)
    private readonly entitlements: ShopFunctionsEntitlements,
  ) {}

  async require(shopId: string): Promise<void> {
    if (!(await this.entitlements.has(shopId)))
      throw new Domain_EntitlementRequiredError(SHOP_FUNCTIONS_FEATURE);
  }
}
