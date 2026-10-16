import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import type { orderEventSchemas } from '@marketplace-sandbox/contracts';
import type { z } from 'zod';
import { LEDGER_ACCOUNTS, shopAccount } from '../domain/account';
import { CommissionRateQueryService } from '@app/domains/statements';
import { settlementLines } from '../domain/settlement-payload';
import { nextSettlementStep } from '../domain/settlement-retry';
import { splitSettlement } from '../domain/settlement-split';
import { JOURNAL_STORE, type JournalStore } from '../domain/ledger-ports';
import {
  settlementDeferredCounter,
  settlementSkippedCounter,
} from '../domain/ledger-metrics';
import { JournalPostingService } from './journal-posting.service';

export type OrderPaidPayload = z.infer<
  (typeof orderEventSchemas)['order.paid']
>;

export type SettleOutcome =
  | 'settled'
  | 'duplicate'
  | 'skipped_refunded'
  | 'sale_missing'
  | 'invalid_payload'
  | 'currency_mismatch';

/**
 * `order.paid` -> one `SETTLEMENT` journal (S14 FR-015…FR-017, research R-6, J01 G-10): the clearing credit of the sale
 * goes to the shops of the order (their lines less commission) and to `PLATFORM_FEES` (the commission, priced by S16
 * as of `paidAt`). Idempotent per order (the journal
 * id is deterministic), serialized with the refund of the same payment, and deferred while the sale is not recorded.
 */
@Injectable()
export class SettlementService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly posting: JournalPostingService,
    @Inject(JOURNAL_STORE) private readonly journals: JournalStore,
    private readonly jobs: JobsService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly rates: CommissionRateQueryService,
  ) {}

  async settle(paid: OrderPaidPayload): Promise<SettleOutcome> {
    const lines = settlementLines(paid.lines, paid.shopOrders, paid.totalMinor);
    const paidAt = new Date(paid.paidAt);
    if (!lines || Number.isNaN(paidAt.getTime())) return 'invalid_payload';

    return this.transactions.run(async (tx) => {
      const sale = await this.journals.findSaleByOrder(paid.orderId, tx);
      if (!sale || !sale.paymentId) return 'sale_missing';
      if (paid.currency !== sale.currency) return 'currency_mismatch';

      // Serialize with the refund of this payment, then look at what the other side did.
      await this.journals.lockPayment(sale.paymentId, tx);
      if (await this.journals.findByPayment('REFUND', sale.paymentId, tx)) {
        settlementSkippedCounter.add(1, { reason: 'refunded' });
        return 'skipped_refunded';
      }
      if (await this.journals.findSettlementByOrder(paid.orderId, tx))
        return 'duplicate';

      // The sale booked the whole captured amount to clearing; the event's lines must add up to exactly that.
      const net = sale.clearingMinor ?? 0;
      if (net <= 0 || net !== paid.totalMinor) return 'invalid_payload';
      // The commission of S16, line by line, with the rate in force on `paidAt`: the same pricing the statement shows.
      const priced = await this.rates.priceLines(lines, paidAt);
      const split = splitSettlement(priced);
      const shares = split.shares.filter((s) => s.shareMinor > 0);
      const result = await this.posting.post(
        {
          kind: 'SETTLEMENT',
          reference: paid.orderId,
          currency: sale.currency,
          shardKey: paid.orderId,
          fromCaller: false,
          lines: [
            { accountId: LEDGER_ACCOUNTS.CLEARING, amountMinor: -net },
            ...shares.map((s) => ({
              accountId: shopAccount(s.shopId),
              amountMinor: s.shareMinor,
            })),
            ...(split.commissionMinor > 0
              ? [
                  {
                    accountId: LEDGER_ACCOUNTS.PLATFORM_FEES,
                    amountMinor: split.commissionMinor,
                  },
                ]
              : []),
          ],
          links: {
            paymentId: sale.paymentId,
            orderId: paid.orderId,
            paymentRef: sale.paymentRef,
            clearingMinor: net,
          },
        },
        tx,
      );
      return result.created ? 'settled' : 'duplicate';
    });
  }

  /**
   * The sale is not there yet: the next attempt becomes a durable job after the scheduled wait (the consumer must not
   * stall its partition for ten minutes). `attempt` is the number of the attempt that just failed. Returns false when
   * the schedule is spent.
   */
  async defer(paid: OrderPaidPayload, attempt: number): Promise<boolean> {
    const step = nextSettlementStep(attempt);
    if (!step) return false;
    const next = attempt + 1;
    await this.jobs.enqueue(
      'ledger.settle-order',
      { paid, attempt: next },
      {
        idempotencyKey: `settle:${paid.orderId}:${next}`,
        runAt: new Date(this.clock.now().getTime() + step.delayMs),
        maxAttempts: 1,
      },
    );
    if (attempt === 1) settlementDeferredCounter.add(1);
    return true;
  }
}
