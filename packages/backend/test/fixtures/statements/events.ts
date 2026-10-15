import { v7 as uuidv7, v4 as uuidv4 } from 'uuid';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';

/**
 * Message builders for the statements fixtures (S16 test-plan.md "Fixtures"): the three events the consumers read, as
 * their producers publish them, plus one buyer identifier (`userId`) that must never reach the statements' store.
 */
export interface LineInput {
  lineId?: string;
  productId?: string;
  shopId: string;
  category?: string;
  quantity?: number;
  unitPriceMinor: number;
  discountMinor?: number;
  lineTotalMinor?: number;
}

export interface OrderPaidInput {
  orderId?: string;
  orderVersion?: number;
  paidAt: string;
  occurredAt?: string;
  eventId?: string;
  currency?: string;
  lines: LineInput[];
  /** Replaces the whole payload (invalid-message cases). */
  payload?: Record<string, unknown>;
  version?: number;
}

export function orderPaid(input: OrderPaidInput): EventEnvelope {
  const orderId = input.orderId ?? uuidv4();
  const lines = input.lines.map((line) => {
    const quantity = line.quantity ?? 1;
    const discountMinor = line.discountMinor ?? 0;
    return {
      lineId: line.lineId ?? uuidv4(),
      productId: line.productId ?? uuidv4(),
      shopId: line.shopId,
      title: 'A product title',
      category: line.category ?? 'electronics',
      quantity,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor,
      lineTotalMinor:
        line.lineTotalMinor ?? quantity * line.unitPriceMinor - discountMinor,
    };
  });
  return {
    eventId: input.eventId ?? uuidv7(),
    type: 'order.paid',
    version: input.version ?? 1,
    aggregateType: 'orders',
    aggregateId: orderId,
    aggregateVersion: input.orderVersion ?? 1,
    occurredAt: input.occurredAt ?? input.paidAt,
    payload: input.payload ?? {
      orderId,
      userId: `buyer-${orderId.slice(0, 8)}`,
      orderVersion: input.orderVersion ?? 1,
      totalMinor: lines.reduce((sum, l) => sum + l.lineTotalMinor, 0),
      currency: input.currency ?? 'EUR',
      paymentRef: 'pi_fixture',
      paidAt: input.paidAt,
      lines,
      shopOrders: [],
    },
  };
}

export interface PayoutPaidInput {
  payoutId?: string;
  shopId: string;
  amountMinor: number;
  paidAt: string;
  payoutVersion?: number;
  occurredAt?: string;
  eventId?: string;
  currency?: string;
  type?: string;
}

export function payoutPaid(input: PayoutPaidInput): EventEnvelope {
  const payoutId = input.payoutId ?? uuidv4();
  const type = input.type ?? 'payout.paid';
  return {
    eventId: input.eventId ?? uuidv7(),
    type,
    version: 1,
    aggregateType: 'payouts',
    aggregateId: payoutId,
    aggregateVersion: input.payoutVersion ?? 1,
    occurredAt: input.occurredAt ?? input.paidAt,
    payload: {
      payoutId,
      shopId: input.shopId,
      periodStart: '2026-03-23',
      amountMinor: input.amountMinor,
      currency: input.currency ?? 'EUR',
      payoutVersion: input.payoutVersion ?? 1,
      ...(type === 'payout.paid'
        ? { transferRef: 'tr_fixture', paidAt: input.paidAt }
        : {}),
    },
  };
}

export interface JournalInput {
  journalId?: string;
  kind?: string;
  orderId?: string | null;
  postedAt: string;
  occurredAt?: string;
  eventId?: string;
  version?: number;
  /** `[accountId, amountMinor]` pairs; positive is a credit. */
  lines: [string, number][];
}

export function ledgerJournal(input: JournalInput): EventEnvelope {
  const journalId = input.journalId ?? uuidv4();
  const version = input.version ?? 2;
  return {
    eventId: input.eventId ?? uuidv7(),
    type: 'ledger.journal_posted',
    version,
    aggregateType: 'ledger',
    aggregateId: journalId,
    aggregateVersion: 1,
    occurredAt: input.occurredAt ?? input.postedAt,
    payload:
      version === 1
        ? { kind: input.kind ?? 'SALE', deltas: [] }
        : {
            journalId,
            kind: input.kind ?? 'SALE',
            currency: 'EUR',
            postedAt: input.postedAt,
            lines: input.lines.map(([accountId, amountMinor], i) => ({
              accountId,
              shard: i,
              amountMinor,
              balanceAfterMinor: Math.abs(amountMinor),
              balanceVersion: i + 1,
            })),
            ...(input.orderId === null
              ? {}
              : { orderId: input.orderId ?? uuidv4() }),
          },
  };
}
