import { Module } from '@nestjs/common';
import { ProblemCatalogModule } from '@app/common/errors/problem-catalog.module';
import { AuthModule } from '@app/domains/identity';
import { TransactionModule } from '@app/infrastructure/context/transaction.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { FlagsClientController } from './api/flags-client.controller';
import { FlagsAdminController } from './api/flags-admin.controller';
import { FlagCommandService } from './application/flag-command.service';
import { FlagQueryService } from './application/flag-query.service';
import { RulesetPublisherService } from './application/ruleset-publisher.service';
import { FLAG_AGGREGATE } from './domain/flag-events';
import { FLAG_PROBLEMS } from './domain/flag-errors';
import { FlagsStoresModule } from './flags-stores.module';
import { flagsRatePolicies } from './rate-limit-policies';

/**
 * S38 admin routes and the client endpoint (apps/core). The SDK itself (`FlagsSdkModule`, global) must also be imported
 * by the app: the client endpoint evaluates through it.
 */
@Module({
  imports: [
    AuthModule,
    TransactionModule,
    FlagsStoresModule,
    EventsModule.forAggregates([FLAG_AGGREGATE]),
    ProblemCatalogModule.forFeature(FLAG_PROBLEMS),
    RateLimitModule.forFeature(flagsRatePolicies),
  ],
  providers: [FlagCommandService, FlagQueryService, RulesetPublisherService],
  controllers: [FlagsAdminController, FlagsClientController],
})
export class FlagsAdminModule {}
