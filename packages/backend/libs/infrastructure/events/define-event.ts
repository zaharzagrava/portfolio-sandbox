import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { context, propagation } from '@opentelemetry/api';
import { DomainTopic, EventEnvelope, topicFor } from './event-envelope';

export interface EventDefinition<TName extends string, TAggregate extends string, TSchema extends z.ZodType> {
  name: TName;
  aggregateType: TAggregate;
  schemaVersion: number;
  topic: DomainTopic<TAggregate>;
  schema: TSchema;
  create(aggregateId: string, version: number, payload: z.infer<TSchema>, occurredAt?: Date): EventEnvelope<TName, z.infer<TSchema>>;
  /** Narrows + validates an incoming envelope; returns null for other event names. */
  match(envelope: EventEnvelope): EventEnvelope<TName, z.infer<TSchema>> | null;
}

/**
 * Typed event definitions: name, owning aggregate, payload schema. Producers
 * get compile-time payload types, consumers get runtime validation at the
 * boundary (Kafka is a trust boundary, lesson 01/02 §8).
 *
 *   export const AuctionBidPlaced = defineEvent('auction.bid_placed', 'auctions', 1, z.object({...}));
 */
export function defineEvent<TName extends string, TAggregate extends string, TSchema extends z.ZodType>(
  name: TName,
  aggregateType: TAggregate,
  schemaVersion: number,
  schema: TSchema,
): EventDefinition<TName, TAggregate, TSchema> {
  return {
    name,
    aggregateType,
    schemaVersion,
    topic: topicFor(aggregateType),
    schema,
    create(aggregateId, version, payload, occurredAt = new Date()) {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      return {
        eventId: uuidv7(),
        eventName: name,
        aggregateType,
        aggregateId,
        version,
        occurredAt: occurredAt.toISOString(),
        schemaVersion,
        traceparent: carrier.traceparent,
        payload: schema.parse(payload),
      };
    },
    match(envelope) {
      if (envelope.eventName !== name) return null;
      return { ...envelope, eventName: name, payload: schema.parse(envelope.payload) };
    },
  };
}
