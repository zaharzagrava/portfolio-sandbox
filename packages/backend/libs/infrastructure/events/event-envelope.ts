import { z } from 'zod';

/**
 * Every domain event on Kafka uses this envelope (lesson 06/01 §7):
 *  - eventId: consumer-side dedupe (inbox) key
 *  - aggregateId: Kafka message key → per-aggregate ordering
 *  - version: aggregate version after the change → version-guarded projections
 *  - schemaVersion: payload contract version (consumers upcast old versions)
 *  - traceparent: W3C trace context across the async hop
 */
export const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  eventName: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  version: z.number().int().nonnegative(),
  occurredAt: z.string(),
  schemaVersion: z.number().int().positive(),
  traceparent: z.string().optional(),
  payload: z.unknown(),
});

export interface EventEnvelope<TName extends string = string, TPayload = unknown> {
  eventId: string;
  eventName: TName;
  aggregateType: string;
  aggregateId: string;
  version: number;
  occurredAt: string;
  schemaVersion: number;
  traceparent?: string;
  payload: TPayload;
}

/** `orders.events`, `auctions.events`, ... - one topic per aggregate type. */
export type DomainTopic<A extends string = string> = `${A}.events`;

export const topicFor = <A extends string>(aggregateType: A): DomainTopic<A> => `${aggregateType}.events`;
