import { eventEnvelopeSchema } from '@marketplace-sandbox/contracts';

/** The envelope schema lives in `packages/contracts` (S53 FR-007); the backend re-exports that very object. */
export { eventEnvelopeSchema };

/**
 * Every domain event on the outbox and on Kafka uses this envelope (field rules: `contracts/envelope.md`):
 *  - eventId: UUIDv7, consumer-side dedupe (inbox) key
 *  - type + version: payload contract (consumers route on the pair and upcast older versions)
 *  - aggregateId: Kafka message key, per-aggregate ordering
 *  - aggregateVersion: aggregate state version after the change, drives version-guarded projections
 *  - traceparent: W3C trace context across the async hop
 */
export interface EventEnvelope<
  TType extends string = string,
  TPayload = Record<string, unknown>,
> {
  eventId: string;
  type: TType;
  version: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  traceparent?: string;
  payload: TPayload;
}

/** `orders.events`, `auctions.events`, ... - one topic per aggregate type. */
export type DomainTopic<A extends string = string> = `${A}.events`;

export const topicFor = <A extends string>(aggregateType: A): DomainTopic<A> =>
  `${aggregateType}.events`;
