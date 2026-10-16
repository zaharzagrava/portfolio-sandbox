import { v7 as uuidv7 } from 'uuid';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { Projector } from '@app/infrastructure/projections/projector';

export interface PaidLine {
  productId: string;
  shopId: string | null;
  title?: string;
  quantity?: number;
}

/** A contract-valid `order.paid` payload (S10 `orderEventSchemas`); orders themselves are never created (D-7). */
export function paidPayload(input: {
  orderId?: string;
  userId: string;
  orderVersion?: number;
  paidAt?: string;
  lines: PaidLine[];
}) {
  return {
    orderId: input.orderId ?? uuidv7(),
    userId: input.userId,
    orderVersion: input.orderVersion ?? 3,
    totalMinor: 1_000 * input.lines.length,
    currency: 'USD',
    paymentRef: 'pi_test',
    paidAt: input.paidAt ?? new Date().toISOString(),
    lines: input.lines.map((l, i) => ({
      lineId: `line-${i}`,
      productId: l.productId,
      shopId: l.shopId,
      title: l.title ?? `Product ${i}`,
      quantity: l.quantity ?? 1,
      unitPriceMinor: 1_000,
      discountMinor: 0,
      lineTotalMinor: 1_000 * (l.quantity ?? 1),
    })),
    shopOrders: [],
  };
}

export function refundedPayload(input: {
  orderId: string;
  userId: string;
  orderVersion?: number;
}) {
  return {
    orderId: input.orderId,
    userId: input.userId,
    orderVersion: input.orderVersion ?? 5,
    amountMinor: 1_000,
    currency: 'USD',
    reason: 'requested_by_customer',
  };
}

/** An envelope exactly as the log would carry it, valid or not (no producer-side validation). */
export function envelope(
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: unknown,
  aggregateVersion = 1,
): EventEnvelope {
  return {
    eventId: uuidv7(),
    type,
    version: 1,
    aggregateType,
    aggregateId,
    aggregateVersion,
    occurredAt: new Date().toISOString(),
    payload: payload as Record<string, unknown>,
  };
}

export const paidEvent = (payload: { orderId: string }) =>
  envelope('order.paid', 'orders', payload.orderId, payload, 1);
export const refundedEvent = (payload: { orderId: string }) =>
  envelope('order.refunded', 'orders', payload.orderId, payload, 2);

/**
 * Delivers an event to a consumer the way the framework does: a `PermanentError` is a dead letter (nothing applied,
 * processing goes on), any other error propagates.
 */
export async function deliver(
  consumer: Projector,
  event: EventEnvelope,
): Promise<{ delivered: boolean }> {
  try {
    await consumer.project([event]);
    return { delivered: true };
  } catch (error) {
    if (error instanceof PermanentError) return { delivered: false };
    throw error;
  }
}
