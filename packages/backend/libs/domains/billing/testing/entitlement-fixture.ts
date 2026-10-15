import { Controller, Get, Module } from '@nestjs/common';
import { BillingModule, RequiresShopEntitlement } from '@app/domains/billing';
import { AuthModule } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';

/** How many times a guarded handler ran: a denied request must leave it unchanged (S18 AS-09, AS-11). */
export const fixtureHits = { guarded: 0 };

/**
 * The tiny fixture controller of S18's test plan: one route carrying `RequiresShopEntitlement('auctions')` above
 * `ShopScoped('shop.read')`, mounted with the production prefix, pipe and filter by the spec's app.
 */
@Controller('fixture')
export class EntitlementFixtureController {
  @RequiresShopEntitlement('auctions')
  @ShopScoped('shop.read')
  @Get('shops/:shopId/guarded')
  guarded() {
    fixtureHits.guarded++;
    return { ok: true };
  }
}

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [EntitlementFixtureController],
})
export class EntitlementFixtureModule {}
