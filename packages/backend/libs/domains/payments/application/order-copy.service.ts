import { Inject, Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import type { z } from 'zod';
import type { orderEventSchemas } from '@marketplace-sandbox/contracts';
import type { OrderCopy } from '../domain/order-copy';
import {
  ORDER_COPY_REPOSITORY,
  type OrderCopyRepository,
} from '../domain/ports';

type Schemas = typeof orderEventSchemas;

export type OrderFact =
  | { type: 'order.reserved'; payload: z.infer<Schemas['order.reserved']> }
  | { type: 'order.paid'; payload: z.infer<Schemas['order.paid']> }
  | { type: 'order.cancelled'; payload: z.infer<Schemas['order.cancelled']> };

const POLL_MS = 100;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The order copy (R3): what payments knows about an order, fed by `orders.events` (S13 FR-005). `apply` is one
 * version-guarded statement (duplicates, stale and out-of-order messages change nothing); `waitForPayable` hides the
 * outbox-to-consumer lag by polling up to the configured wait, outside any transaction.
 */
@Injectable()
export class OrderCopyService {
  constructor(
    @Inject(ORDER_COPY_REPOSITORY) private readonly copies: OrderCopyRepository,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Returns false when the message was stale (an equal or newer version is stored). */
  apply(fact: OrderFact): Promise<boolean> {
    return this.copies.upsertVersioned(toCopy(fact), this.clock.now());
  }

  /**
   * The copy of `orderId` if it belongs to `userId`; null when it is missing after the wait or belongs to someone
   * else: callers answer both the same way (no probing of other buyers' orders).
   */
  async waitFor(orderId: string, userId: string): Promise<OrderCopy | null> {
    const budget = this.config.get('payments_order_copy_wait_ms');
    for (let waited = 0; ; waited += POLL_MS) {
      const copy = await this.copies.find(orderId);
      if (copy) return copy.userId === userId ? copy : null;
      if (waited + POLL_MS > budget) return null;
      await sleep(POLL_MS);
    }
  }
}

function toCopy(fact: OrderFact): OrderCopy {
  const p = fact.payload;
  switch (fact.type) {
    case 'order.reserved':
      return {
        orderId: p.orderId,
        userId: p.userId,
        totalMinor: (p as { totalMinor: number }).totalMinor,
        currency: (p as { currency: string }).currency,
        status: 'RESERVED',
        reservedUntil: new Date((p as { reservedUntil: string }).reservedUntil),
        orderVersion: p.orderVersion,
      };
    case 'order.paid':
      return {
        orderId: p.orderId,
        userId: p.userId,
        totalMinor: (p as { totalMinor: number }).totalMinor,
        currency: (p as { currency: string }).currency,
        status: 'PAID',
        reservedUntil: null,
        orderVersion: p.orderVersion,
      };
    case 'order.cancelled':
      return {
        orderId: p.orderId,
        userId: p.userId,
        totalMinor: null,
        currency: null,
        status: 'CANCELLED',
        reservedUntil: null,
        orderVersion: p.orderVersion,
      };
  }
}
