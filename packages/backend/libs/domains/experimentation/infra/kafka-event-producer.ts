import { Injectable } from '@nestjs/common';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { withTimeout } from '../domain/with-timeout';
import { ANALYTICS_TOPIC, type StoredEvent } from '../domain/event-schema';
import type { EventProducer } from '../domain/ports';

/** The fallback answers only after the stream acknowledged the batch, within this limit (S39 FR-007). */
export const PRODUCE_TIMEOUT_MS = 2_000;

/**
 * Publishes accepted events on `analytics.events`, keyed by `anonymous_id`. The topic is a standard one: the message
 * carries only a key and a value, never a FIFO option such as `groupId` (L-001). One attempt here; the client retries the
 * same `event_id`s and the store collapses them (one retry layer, IV.6).
 */
@Injectable()
export class KafkaEventProducer implements EventProducer {
  constructor(private readonly producer: KafkaProducerService) {}

  async sendMany(events: StoredEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await withTimeout(
        this.producer.sendMany(
          ANALYTICS_TOPIC,
          events.map((event) => ({ key: event.anonymous_id, value: event })),
        ),
        PRODUCE_TIMEOUT_MS,
        `produce to ${ANALYTICS_TOPIC}`,
      );
    } catch (error) {
      // The abandoned request must not hold the producer's single in-flight slot against the client's retry.
      void this.producer.reset('publisher').catch(() => undefined);
      throw error;
    }
  }
}
