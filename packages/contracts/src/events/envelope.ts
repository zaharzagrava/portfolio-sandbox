import { z } from 'zod';

/** Lowercase dotted event type: `order.paid`, `product.price_changed` (S53 FR-007). */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * The one envelope every event carries, on the outbox row, on Kafka (poller and CDC identical) and in consumers.
 *  - eventId: UUIDv7, stable across duplicate deliveries (inbox key)
 *  - type + version: payload contract (additive changes keep the version)
 *  - aggregateId: message key, per-aggregate ordering
 *  - aggregateVersion: aggregate state version after the change, strictly increasing per aggregate (version guard)
 */
export const eventEnvelopeSchema = z.object({
  eventId: z.uuidv7(),
  type: z.string().regex(EVENT_TYPE_PATTERN),
  version: z.number().int().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  aggregateVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  occurredAt: z.iso.datetime(),
  traceparent: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export type EventEnvelopeShape = z.infer<typeof eventEnvelopeSchema>;
