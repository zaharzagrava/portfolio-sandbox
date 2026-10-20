import { Inject, Injectable } from '@nestjs/common';
import { v5 as uuidv5 } from 'uuid';
import type { z } from 'zod';
import type { orderEventSchemas } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import type { SinkCounts } from '@app/infrastructure/projections/projector';
import {
  CONVERSION_STORE,
  type ConversionRow,
  type ConversionStore,
} from '../domain/conversion-ports';
import { LinkConversionReversed, LinkConverted } from '../domain/link-events';

type Paid = z.infer<(typeof orderEventSchemas)['order.paid']>;
type Refunded = z.infer<(typeof orderEventSchemas)['order.refunded']>;

/** Namespace of the conversion ids (UUID v5 of the order id): the same order always lands on the same id. */
const CONVERSION_NAMESPACE = 'b7f1c2de-5a4e-4c1b-9a63-0f4d6f1e7a21';

export const conversionIdOf = (orderId: string): string =>
  uuidv5(orderId, CONVERSION_NAMESPACE);

/**
 * Turns `order.paid` / `order.refunded` into affiliate conversions (J05). Idempotent on the order id (unique row) with a
 * version guard on refunds; a refund that arrives before its payment is kept as `PENDING_REFUND` and merged when the
 * payment comes. The row and its `link.converted` / `link.conversion_reversed` events commit in one transaction per batch.
 */
@Injectable()
export class ConversionIngestService {
  constructor(
    @Inject(CONVERSION_STORE) private readonly store: ConversionStore,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async ingest(
    events: Array<
      | { kind: 'paid'; envelope: EventEnvelope; payload: Paid }
      | { kind: 'refunded'; envelope: EventEnvelope; payload: Refunded }
    >,
  ): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    const now = this.clock.now();
    await this.runner.run(async () => {
      for (const event of events) {
        const orderId = event.envelope.aggregateId;
        const emitted =
          event.kind === 'paid'
            ? await this.paid(orderId, event.payload, now)
            : await this.refunded(orderId, event.payload, now);
        if (emitted === null) {
          counts.stale += 1;
          continue;
        }
        if (emitted === 'duplicate') {
          counts.duplicate += 1;
          continue;
        }
        counts.applied += 1;
        await this.outbox.append(emitted);
      }
    });
    return counts;
  }

  private async paid(
    orderId: string,
    p: Paid,
    now: Date,
  ): Promise<EventEnvelope[] | 'duplicate' | null> {
    if (!p.attribution) return null;
    const existing = await this.store.lockByOrder(orderId);
    if (existing && existing.status !== 'PENDING_REFUND') return 'duplicate';

    const refundedMinor = Math.min(existing?.refundedMinor ?? 0, p.totalMinor);
    const reversed = refundedMinor >= p.totalMinor && p.totalMinor > 0;
    const row: ConversionRow = {
      id: conversionIdOf(orderId),
      linkCode: p.attribution.code,
      ownerId: p.attribution.ownerId,
      orderId,
      amountMinor: p.totalMinor,
      currency: p.currency,
      status: reversed ? 'REVERSED' : 'CONFIRMED',
      refundedMinor,
      orderVersion: Math.max(existing?.orderVersion ?? 0, p.orderVersion),
      paidAt: new Date(p.paidAt),
    };
    if (existing) await this.store.update(row, now);
    else if (!(await this.store.insert(row, now))) return 'duplicate';
    return [
      this.converted(row, now),
      ...(reversed ? [this.reversed(row, now)] : []),
    ];
  }

  private async refunded(
    orderId: string,
    p: Refunded,
    now: Date,
  ): Promise<EventEnvelope[] | 'duplicate' | null> {
    if (!p.attribution) return null;
    const existing = await this.store.lockByOrder(orderId);
    if (!existing) {
      const row: ConversionRow = {
        id: conversionIdOf(orderId),
        linkCode: p.attribution.code,
        ownerId: p.attribution.ownerId,
        orderId,
        amountMinor: 0,
        currency: p.currency,
        status: 'PENDING_REFUND',
        refundedMinor: p.amountMinor,
        orderVersion: p.orderVersion,
        paidAt: null,
      };
      return (await this.store.insert(row, now)) ? [] : 'duplicate';
    }
    // Every refund carries its own, higher order version: an equal or lower one is a redelivery.
    if (
      p.orderVersion <= existing.orderVersion ||
      existing.status === 'REVERSED'
    )
      return 'duplicate';
    if (existing.status === 'PENDING_REFUND') {
      await this.store.update(
        {
          ...existing,
          refundedMinor: existing.refundedMinor + p.amountMinor,
          orderVersion: p.orderVersion,
        },
        now,
      );
      return [];
    }
    const refundedMinor = Math.min(
      existing.amountMinor,
      existing.refundedMinor + p.amountMinor,
    );
    const reversed = refundedMinor >= existing.amountMinor;
    const row: ConversionRow = {
      ...existing,
      refundedMinor,
      status: reversed ? 'REVERSED' : 'CONFIRMED',
      orderVersion: p.orderVersion,
    };
    await this.store.update(row, now);
    return reversed ? [this.reversed(row, now)] : [];
  }

  private converted(row: ConversionRow, now: Date): EventEnvelope {
    return LinkConverted.create(
      row.linkCode,
      row.orderVersion,
      {
        conversionId: row.id,
        linkCode: row.linkCode,
        amountMinor: row.amountMinor,
        currency: row.currency,
        paidAt: (row.paidAt ?? now).toISOString(),
      },
      now,
    );
  }

  private reversed(row: ConversionRow, now: Date): EventEnvelope {
    return LinkConversionReversed.create(
      row.linkCode,
      row.orderVersion,
      {
        conversionId: row.id,
        linkCode: row.linkCode,
        refundedMinor: row.refundedMinor,
        amountMinor: row.amountMinor,
      },
      now,
    );
  }
}
