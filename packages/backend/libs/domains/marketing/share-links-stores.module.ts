import { Module } from '@nestjs/common';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { LINK_AGGREGATE } from './domain/link-events';
import {
  CLICK_PUBLISHER,
  CLICK_STATS_READER,
  CODE_SEQUENCE,
  DESTINATION_REPUTATION,
  EXISTENCE_FILTER,
  LINK_CACHE,
  LINK_REPOSITORY,
} from './domain/ports';
import { AllowAllReputationAdapter } from './infra/allow-all-reputation.adapter';
import { ClickhouseClickStatsReader } from './infra/clickhouse-click-stats.reader';
import { DynamoLinkRepository } from './infra/dynamo-link.repository';
import { KafkaClickPublisher } from './infra/kafka-click.publisher';
import { RedisCodeSequence } from './infra/redis-code-sequence';
import { RedisExistenceFilter } from './infra/redis-existence.filter';
import { RedisLinkCache } from './infra/redis-link.cache';

const PORTS = [
  LINK_REPOSITORY,
  CODE_SEQUENCE,
  EXISTENCE_FILTER,
  CLICK_PUBLISHER,
  CLICK_STATS_READER,
  DESTINATION_REPUTATION,
  LINK_CACHE,
];

/**
 * The stores and adapters of share links behind their port tokens (S37 L1, L6). Shared by the HTTP side and the worker
 * so there is one copy of each adapter per process. Redis, DynamoDB and the cache are global modules; tests replace a
 * token with a fault-injecting wrapper (`overrideProvider(LINK_REPOSITORY)`).
 */
@Module({
  imports: [
    KafkaProducerModule,
    ClickHouseModule,
    EventsModule.forAggregates([LINK_AGGREGATE]),
  ],
  providers: [
    DynamoLinkRepository,
    RedisCodeSequence,
    RedisExistenceFilter,
    RedisLinkCache,
    KafkaClickPublisher,
    ClickhouseClickStatsReader,
    AllowAllReputationAdapter,
    { provide: LINK_REPOSITORY, useExisting: DynamoLinkRepository },
    { provide: CODE_SEQUENCE, useExisting: RedisCodeSequence },
    { provide: EXISTENCE_FILTER, useExisting: RedisExistenceFilter },
    { provide: CLICK_PUBLISHER, useExisting: KafkaClickPublisher },
    { provide: CLICK_STATS_READER, useExisting: ClickhouseClickStatsReader },
    { provide: DESTINATION_REPUTATION, useExisting: AllowAllReputationAdapter },
    { provide: LINK_CACHE, useExisting: RedisLinkCache },
  ],
  exports: PORTS,
})
export class ShareLinksStoresModule {}
