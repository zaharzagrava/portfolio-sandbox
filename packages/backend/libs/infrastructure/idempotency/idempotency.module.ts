import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ProblemCatalogModule } from '@app/common/errors/problem-catalog.module';
import { IDEMPOTENCY_PROBLEMS } from './idempotency.errors';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyKeyModel } from './idempotency-key.model';
import { IdempotencyRepository } from './idempotency.repository';
import { IdempotencyPurgeService } from './purge.service';

/** Import in the module of any controller that uses `@Idempotent()`. Needs the app's `DatabaseModule`. */
@Module({
  imports: [
    SequelizeModule.forFeature([IdempotencyKeyModel]),
    ProblemCatalogModule.forFeature(IDEMPOTENCY_PROBLEMS),
  ],
  providers: [
    IdempotencyRepository,
    IdempotencyInterceptor,
    IdempotencyPurgeService,
  ],
  exports: [
    IdempotencyRepository,
    IdempotencyInterceptor,
    IdempotencyPurgeService,
  ],
})
export class IdempotencyModule {}
