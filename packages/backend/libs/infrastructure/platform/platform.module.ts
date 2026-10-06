import { Global, Module } from '@nestjs/common';
import { RequestContextModule } from '@app/infrastructure/context/request-context.module';
import { TransactionModule } from '@app/infrastructure/context/transaction.module';
import { HealthModule } from '@app/infrastructure/health/health.module';
import { LoadSheddingModule } from '@app/common/load-shedding/load-shedding.module';
import { LoggingModule } from '@app/common/logging/logging.module';

/**
 * F-01 platform toolkit in one import for HTTP apps: request context (CLS),
 * CLS-managed transactions, /livez + /readyz, ordered shutdown, event-loop
 * load shedding, structured logging.
 */
@Global()
@Module({
  imports: [RequestContextModule, TransactionModule, HealthModule, LoadSheddingModule, LoggingModule],
  exports: [RequestContextModule, TransactionModule, HealthModule, LoadSheddingModule, LoggingModule],
})
export class PlatformModule {}

/** Same toolkit minus CLS transactions, for apps with no database (BFF). */
@Global()
@Module({
  imports: [RequestContextModule, HealthModule, LoadSheddingModule, LoggingModule],
  exports: [RequestContextModule, HealthModule, LoadSheddingModule, LoggingModule],
})
export class StatelessPlatformModule {}
