import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RealtimeModule } from '@app/infrastructure/realtime';
import {
  EVAL_COUNTER_STORE,
  FLAG_REPOSITORY,
  RULESET_PUBLISHER,
  RULESET_SOURCE,
} from './domain/ports';
import FeatureFlagModel from './infra/models/feature-flag.model';
import FlagAuditModel from './infra/models/flag-audit.model';
import FlagRulesetModel from './infra/models/flag-ruleset.model';
import { RedisEvalCounters } from './infra/redis-eval-counters';
import { RedisRulesetPublisher } from './infra/redis-ruleset.publisher';
import { RedisRulesetSource } from './infra/redis-ruleset.source';
import { SequelizeFlagRepository } from './infra/sequelize-flag.repository';

const PORTS = [
  FLAG_REPOSITORY,
  RULESET_PUBLISHER,
  RULESET_SOURCE,
  EVAL_COUNTER_STORE,
];

/**
 * The stores and adapters of flags behind their port tokens (S38 B1): the database repository, the cache publisher and
 * source and the counter store. Shared by the SDK, the admin side and the worker so there is one copy of each adapter
 * per process; a test replaces a token with a fault-injecting wrapper.
 */
@Module({
  imports: [
    SequelizeModule.forFeature([
      FeatureFlagModel,
      FlagAuditModel,
      FlagRulesetModel,
    ]),
    RealtimeModule,
    ClockModule,
  ],
  providers: [
    SequelizeFlagRepository,
    RedisRulesetPublisher,
    RedisRulesetSource,
    RedisEvalCounters,
    { provide: FLAG_REPOSITORY, useExisting: SequelizeFlagRepository },
    { provide: RULESET_PUBLISHER, useExisting: RedisRulesetPublisher },
    { provide: RULESET_SOURCE, useExisting: RedisRulesetSource },
    { provide: EVAL_COUNTER_STORE, useExisting: RedisEvalCounters },
  ],
  exports: PORTS,
})
export class FlagsStoresModule {}
