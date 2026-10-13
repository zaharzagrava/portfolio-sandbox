import { Module } from '@nestjs/common';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import {
  AGGREGATE_READER,
  BILLING_STORE,
  CAMPAIGN_STORE,
  CLICK_LOG,
  IMPRESSION_MARKER,
  PRODUCT_SNAPSHOT_STORE,
  RAW_CLICK_READER,
  SHOP_SNAPSHOT_STORE,
  SPAM_COUNTERS,
  SPEND_COUNTER,
} from './domain/ads-ports';
import { ClickhouseAdReader } from './infra/clickhouse-ad.reader';
import { KafkaClickLog } from './infra/kafka-click.log';
import { RedisImpressionMarker } from './infra/redis-impression.marker';
import { RedisSpamCounters } from './infra/redis-spam.counters';
import { RedisSpendCounter } from './infra/redis-spend.counter';
import { SequelizeBillingStore } from './infra/sequelize-billing.store';
import { SequelizeCampaignStore } from './infra/sequelize-campaign.store';
import {
  SequelizeProductSnapshotStore,
  SequelizeShopSnapshotStore,
} from './infra/sequelize-snapshot.stores';

const PORTS = [
  CAMPAIGN_STORE,
  PRODUCT_SNAPSHOT_STORE,
  SHOP_SNAPSHOT_STORE,
  BILLING_STORE,
  IMPRESSION_MARKER,
  SPAM_COUNTERS,
  SPEND_COUNTER,
  CLICK_LOG,
  RAW_CLICK_READER,
  AGGREGATE_READER,
];

/**
 * The stores and adapters of sponsored listings behind their port tokens (S36 L1, D-6). Shared by the HTTP side, the
 * worker and the projector so there is one copy of each adapter per process. Postgres, Redis and the clock are global
 * modules; tests replace a token with a fault-injecting wrapper (`overrideProvider(CAMPAIGN_STORE)`). The R1 adapters
 * (catalog, shop directory, ledger) are not here: only the modules that need them import the domain they read.
 */
@Module({
  imports: [KafkaProducerModule, ClickHouseModule],
  providers: [
    SequelizeCampaignStore,
    SequelizeProductSnapshotStore,
    SequelizeShopSnapshotStore,
    SequelizeBillingStore,
    RedisImpressionMarker,
    RedisSpamCounters,
    RedisSpendCounter,
    KafkaClickLog,
    ClickhouseAdReader,
    { provide: CAMPAIGN_STORE, useExisting: SequelizeCampaignStore },
    {
      provide: PRODUCT_SNAPSHOT_STORE,
      useExisting: SequelizeProductSnapshotStore,
    },
    { provide: SHOP_SNAPSHOT_STORE, useExisting: SequelizeShopSnapshotStore },
    { provide: BILLING_STORE, useExisting: SequelizeBillingStore },
    { provide: IMPRESSION_MARKER, useExisting: RedisImpressionMarker },
    { provide: SPAM_COUNTERS, useExisting: RedisSpamCounters },
    { provide: SPEND_COUNTER, useExisting: RedisSpendCounter },
    { provide: CLICK_LOG, useExisting: KafkaClickLog },
    { provide: RAW_CLICK_READER, useExisting: ClickhouseAdReader },
    { provide: AGGREGATE_READER, useExisting: ClickhouseAdReader },
  ],
  exports: PORTS,
})
export class AdsStoresModule {}
