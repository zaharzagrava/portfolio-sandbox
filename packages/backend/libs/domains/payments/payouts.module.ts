import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { PayoutsAdminController } from './api/payouts-admin.controller';
import { PayoutsController } from './api/payouts.controller';
import { PayoutsCoreModule } from './payouts-core.module';
import { paymentsRatePolicies } from './rate-limit-policies';

/** HTTP side (apps/core): the seller's payout reads and the finance operator routes for payouts. */
@Module({
  imports: [
    PayoutsCoreModule,
    AuthModule,
    IdempotencyModule,
    RateLimitModule.forFeature(paymentsRatePolicies),
  ],
  controllers: [PayoutsController, PayoutsAdminController],
  exports: [PayoutsCoreModule],
})
export class PayoutsModule {}
