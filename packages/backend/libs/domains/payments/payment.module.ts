import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { PaymentController } from './api/payment.controller';
import { PaymentsCoreModule } from './payments-core.module';
import { paymentsRatePolicies } from './rate-limit-policies';

/** HTTP side (apps/core): the payment routes. Shares its providers with the processor side. */
@Module({
  imports: [
    PaymentsCoreModule,
    AuthModule,
    IdempotencyModule,
    RateLimitModule.forFeature(paymentsRatePolicies),
  ],
  controllers: [PaymentController],
  exports: [PaymentsCoreModule],
})
export class PaymentModule {}
