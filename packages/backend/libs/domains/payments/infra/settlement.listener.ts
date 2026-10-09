import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { v5 as uuidv5 } from 'uuid';
import { TransactionRunner } from '@app/infrastructure/context';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { LedgerService } from '../application/ledger.service';
import {
  LEDGER_ACCOUNTS,
  PLATFORM_FEE_MINOR,
  shopAccount,
} from '../domain/accounts';
import { allocate } from '@app/common/money/allocate';
import { OrderPaid } from '@app/domains/orders';

const SETTLEMENT_NS = '0b9cf0b6-4a6f-4b8e-9d5c-6f0f3c2b9a11';

/**
 * order.paid → SETTLEMENT journal: the net amount sitting in CLEARING is
 * split across the shops of a multi-seller order by their line totals using
 * largest-remainder allocation (sums back to the cent, deterministic), and
 * credited to each SHOP_<id> account (what we owe them).
 * Exactly-once on redelivery: deterministic journalId (UUIDv5 of the order)
 * + an advisory lock + existence check in the same transaction.
 */
@Injectable()
export class SettlementListener implements Projector {
  readonly name = 'order-settlement';
  readonly topics = [OrderPaid.topic];
  // A deterministic journal id (UUIDv5 of the order) plus an existence check under an advisory lock.
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: OrderPaid }];

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
    private readonly ledger: LedgerService,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const raw of events) {
      const event = OrderPaid.match(raw);
      if (!event) continue;
      await this.settle(event.aggregateId, event.payload);
    }
  }

  private async settle(
    orderId: string,
    paid: (typeof OrderPaid)['schema']['_output'],
  ) {
    const shopLines = paid.lines.filter((l) => l.shopId);
    if (shopLines.length === 0) return;

    const byShop = new Map<string, number>();
    for (const l of shopLines)
      byShop.set(
        l.shopId!,
        (byShop.get(l.shopId!) ?? 0) + l.price * l.quantity,
      );
    const shops = [...byShop.keys()].sort();
    const net = Math.max(0, paid.total - PLATFORM_FEE_MINOR);
    const shares = allocate(
      net,
      shops.map((s) => byShop.get(s)!),
    );

    const journalId = uuidv5(`settlement:${orderId}`, SETTLEMENT_NS);
    await this.transactions.run(async (tx) => {
      await this.sequelize.query(
        `SELECT pg_advisory_xact_lock(hashtext(:journalId))`,
        { replacements: { journalId }, transaction: tx },
      );
      const [{ exists }] = await this.sequelize.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM "LedgerEntry" WHERE "journalId" = :journalId) AS exists`,
        {
          type: QueryTypes.SELECT,
          replacements: { journalId },
          transaction: tx,
        },
      );
      if (exists) return;

      await this.ledger.post(
        {
          journalId,
          kind: 'SETTLEMENT',
          paymentId: paid.paymentId.startsWith('pay_') ? null : paid.paymentId,
          lines: [
            { accountId: LEDGER_ACCOUNTS.CLEARING, amount: -net },
            ...shops.map((shopId, i) => ({
              accountId: shopAccount(shopId),
              amount: shares[i],
            })),
          ],
        },
        tx,
      );
    });
  }
}
