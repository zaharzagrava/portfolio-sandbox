import { Injectable } from '@nestjs/common';
import { EntitlementsService } from '@app/domains/billing';
import type { ShopFunctionsEntitlements } from '../domain/ports';

/**
 * The boolean plan entitlement of S18 that switches discount functions on (S45 FR-003). S18's closed key list does not
 * contain it yet (research D-13), so the value is read from the shop's entitlements as plain data instead of through
 * `hasEntitlement`, which would throw `unknown_entitlement` for it. Not there ⇒ not entitled (fail closed): the feature
 * is off in production until S18 adopts the key.
 */
export const SHOP_FUNCTIONS_ENTITLEMENT = 'shopFunctions';

/** Entitlements of shops by R1: one batch call per evaluation, never a read of billing tables. Failures propagate. */
@Injectable()
export class BillingEntitlementsAdapter implements ShopFunctionsEntitlements {
  constructor(private readonly entitlements: EntitlementsService) {}

  async getMany(shopIds: string[]): Promise<Map<string, boolean>> {
    const found = await this.entitlements.getMany('SHOP', shopIds);
    return new Map(
      shopIds.map((id) => [
        id,
        (found.get(id) as Record<string, unknown> | undefined)?.[
          SHOP_FUNCTIONS_ENTITLEMENT
        ] === true,
      ]),
    );
  }

  async has(shopId: string): Promise<boolean> {
    const found = await this.getMany([shopId]);
    return found.get(shopId) === true;
  }
}
