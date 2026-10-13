import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import {
  EVENT_TYPE_PATTERN,
  consumedEventSchemas,
  eventEnvelopeSchema,
  type ConsumedEventType,
} from '@marketplace-sandbox/contracts';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  familyOfType,
  NOTIFICATION_SOURCE_TOPICS,
} from '../infra/notifications.topics';

type PayloadOf<T extends ConsumedEventType> = z.input<
  (typeof consumedEventSchemas)[T]
>;

export interface EnvelopeOptions {
  eventId?: string;
  /** Key of the stream (default: a fresh uuid). */
  aggregateId?: string;
  aggregateVersion?: number;
  occurredAt?: Date;
  /** Payload version (default 1). */
  version?: number;
}

/**
 * A schema-valid S53 envelope for a consumed event: the payload is parsed with the contract schema of its type and the
 * whole envelope with `eventEnvelopeSchema`, so a fixture can never drift from `packages/contracts`. A spec that wants a
 * malformed payload builds it by hand with `rawEnvelope`.
 */
export function envelope<T extends ConsumedEventType>(
  type: T,
  payload: PayloadOf<T>,
  options: EnvelopeOptions = {},
): EventEnvelope {
  const parsed = (consumedEventSchemas[type] as z.ZodType).parse(payload);
  return rawEnvelope(type, parsed as Record<string, unknown>, options);
}

/** Same envelope without payload validation (invalid-payload and unsupported-version tests). */
export function rawEnvelope(
  type: string,
  payload: Record<string, unknown>,
  options: EnvelopeOptions = {},
): EventEnvelope {
  const family = familyOfType(type);
  const topic = family ? NOTIFICATION_SOURCE_TOPICS[family] : 'unknown.events';
  const candidate = {
    eventId: options.eventId ?? uuidv7(),
    type,
    version: options.version ?? 1,
    aggregateType: topic.replace(/\.events$/, ''),
    aggregateId: options.aggregateId ?? uuidv4(),
    aggregateVersion: options.aggregateVersion ?? 1,
    occurredAt: (options.occurredAt ?? new Date()).toISOString(),
    payload,
  };
  // The spec'd names `launch_events.*`, `seller_insights.*` and `developer_platform.*` break the S53 type pattern (no
  // `_` in the first segment): no producer can emit them, so fixtures use the aliases and the canonical names are
  // built without the pattern check, to prove the consumer still reads them (gaps.md, "Sibling-spec follow-ups").
  if (!EVENT_TYPE_PATTERN.test(type)) return candidate as EventEnvelope;
  return eventEnvelopeSchema.parse(candidate) as EventEnvelope;
}

/** `order.paid` with the S10 field names; one shop order per entry of `shops`. */
export function orderPaidEnvelope(
  input: {
    userId: string;
    orderId?: string;
    orderVersion?: number;
    totalMinor?: number;
    currency?: string;
    shops?: Array<{ shopId: string | null; subtotalMinor: number }>;
  },
  options: EnvelopeOptions = {},
): EventEnvelope {
  const orderId = input.orderId ?? uuidv4();
  const orderVersion = input.orderVersion ?? 2;
  const shops = input.shops ?? [];
  const total =
    input.totalMinor ??
    (shops.reduce((n, s) => n + s.subtotalMinor, 0) || 12_990);
  return envelope(
    'order.paid',
    {
      orderId,
      userId: input.userId,
      orderVersion,
      totalMinor: total,
      currency: input.currency ?? 'USD',
      paymentRef: `pay_${uuidv4()}`,
      paidAt: (options.occurredAt ?? new Date()).toISOString(),
      lines: shops.map((s) => ({
        productId: uuidv4(),
        shopId: s.shopId,
        title: 'Item',
        quantity: 1,
        unitPriceMinor: s.subtotalMinor,
        discountMinor: 0,
        lineTotalMinor: s.subtotalMinor,
      })),
      shopOrders: shops.map((s) => ({
        shopOrderId: uuidv4(),
        shopId: s.shopId,
        subtotalMinor: s.subtotalMinor,
      })),
    },
    { aggregateId: orderId, aggregateVersion: orderVersion, ...options },
  );
}
