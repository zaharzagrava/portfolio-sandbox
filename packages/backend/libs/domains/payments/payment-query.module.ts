import { Module } from '@nestjs/common';
import { PaymentsCoreModule } from './payments-core.module';

/**
 * The exported status service (R1) for other domains: import this module and inject `PaymentQueryService` (the one
 * export of the domain's entry point they may use; the rest of the core module is not part of the public contract).
 */
@Module({
  imports: [PaymentsCoreModule],
  exports: [PaymentsCoreModule],
})
export class PaymentQueryModule {}
