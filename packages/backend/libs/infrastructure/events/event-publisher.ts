import { Injectable } from '@nestjs/common';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { MAX_EVENT_BYTES } from './define-event';
import { envelopeMessage } from './envelope-message';
import { EventEnvelope, eventEnvelopeSchema } from './event-envelope';
import { EventTooLargeError, InvalidEnvelopeError } from './event-errors';
import { TopicRegistry } from './topic-registry';

/**
 * Plain producer for events that have no SQL transaction to be atomic with (high-volume `live.*`, search clicks):
 * validates against the envelope contract, keys by `aggregateId`, sends with `acks=-1` through the idempotent
 * producer, 10 s timeout, touches no database (S53 AS-25, AS-26). The caller supplies a stable `eventId`, so a retry
 * of its own relay is safe. Anything that must commit with a state change goes through `OutboxService.append`.
 */
@Injectable()
export class EventPublisher {
  constructor(
    private readonly producer: KafkaProducerService,
    private readonly topics: TopicRegistry,
  ) {}

  publish(envelope: EventEnvelope): Promise<void> {
    return this.publishMany([envelope]);
  }

  /** All envelopes are validated before the first byte is sent; one produce request per topic, order kept. */
  async publishMany(envelopes: EventEnvelope[]): Promise<void> {
    const byTopic = new Map<string, EventEnvelope[]>();
    for (const envelope of envelopes) {
      const parsed = eventEnvelopeSchema.safeParse(envelope);
      if (!parsed.success)
        throw new InvalidEnvelopeError([
          ...new Set(
            parsed.error.issues.map((i) => i.path.join('.') || '(root)'),
          ),
        ]);
      const bytes = Buffer.byteLength(JSON.stringify(envelope));
      if (bytes > MAX_EVENT_BYTES)
        throw new EventTooLargeError(envelope.type, MAX_EVENT_BYTES, bytes);
      const topic = this.topics.topicFor(envelope.aggregateType);
      byTopic.set(topic, [...(byTopic.get(topic) ?? []), envelope]);
    }
    for (const [topic, list] of byTopic)
      await this.producer.sendMany(topic, list.map(envelopeMessage));
  }
}
