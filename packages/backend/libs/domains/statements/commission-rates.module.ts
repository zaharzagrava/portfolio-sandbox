import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { CommissionRateQueryService } from './application/commission-rate-query.service';
import { RATE_REPOSITORY } from './domain/ports';
import { SequelizeCommissionRateRepository } from './infra/commission-rate.repository';

/**
 * The R1 export of the commission rates (S16 Provides): `CommissionRateQueryService` and the repository it reads,
 * nothing else, so another domain (the ledger prices its settlements with it) imports it without taking the statements
 * HTTP, job or projector sides. `StatementsCoreModule` imports it too, so there is one instance of each provider.
 */
@Module({
  imports: [ClockModule, SequelizeModule.forFeature([])],
  providers: [
    { provide: RATE_REPOSITORY, useClass: SequelizeCommissionRateRepository },
    CommissionRateQueryService,
  ],
  exports: [RATE_REPOSITORY, CommissionRateQueryService],
})
export class CommissionRatesModule {}
