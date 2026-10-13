import { Injectable } from '@nestjs/common';
import type { ClickRecord } from '../domain/click-record';
import type { ClickLog } from '../domain/ads-ports';
import { ADS_CLICKS_TOPIC, PUBLISH_TIMEOUT_MS } from '../domain/ads-constants';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { withDeadline } from './ads-timeout';

/**
 * Publishes a click record to `ads.clicks` with the platform's idempotent producer and a 1 s budget (FR-072, G12, G13). The
 * key is `campaignId#<0-9>`, chosen by the caller (deterministic salt). A failure or a timeout is reported to the click
 * service, which removes the dedupe marker and still redirects. A publish that times out but lands later is a duplicate
 * downstream and harmless: the aggregator and the raw log both deduplicate by click id (first verdict wins). Owner:
 * `marketing` (S36).
 */
@Injectable()
export class KafkaClickLog implements ClickLog {
  constructor(private readonly producer: KafkaProducerService) {}

  publish(key: string, record: ClickRecord): Promise<void> {
    return withDeadline('click-log', PUBLISH_TIMEOUT_MS, () =>
      this.producer.send({ topic: ADS_CLICKS_TOPIC, key, value: record }),
    );
  }
}
