import { Inject, Injectable } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import { ApiConfigService, PlatformSettings } from '@app/common/config';
import { LEDGER_ACCOUNTS } from '../domain/account';
import {
  JournalInvalid,
  TransactionRequired,
  type JournalInvalidReason,
} from '../domain/ledger-errors';
import { postRejectedCounter } from '../domain/ledger-metrics';
import {
  JOURNAL_STORE,
  type JournalHeader,
  type JournalStore,
  type StoredLine,
} from '../domain/ledger-ports';
import { JournalPostingService } from './journal-posting.service';

export interface CaptureInput {
  paymentId: string;
  orderId: string;
  paymentRef: string;
  userId: string;
  amountMinor: number;
  currency: string;
}

export interface RefundInput {
  paymentId: string;
  refundRef: string;
  amountMinor: number;
  currency: string;
}

export interface PaymentJournalResult {
  journalId: string;
  created: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Capture and refund of a payment (S14 FR-013, FR-014, research R-7): the rules of the sale and its exact reversal,
 * posted through the one posting path in the caller's transaction. The refund and the settlement of one payment are
 * serialized by a per-payment lock, so either order ends consistently (FR-017).
 */
@Injectable()
export class PaymentPostingsService {
  constructor(
    private readonly posting: JournalPostingService,
    @Inject(JOURNAL_STORE) private readonly journals: JournalStore,
    private readonly config: ApiConfigService,
  ) {
    // The ledger books in the one platform currency, the one every product, order and payment is priced in.
    this.currency = new PlatformSettings(config).currency;
  }

  private readonly currency: string;

  async capture(
    input: CaptureInput,
    tx: Transaction | undefined,
  ): Promise<PaymentJournalResult> {
    if (!UUID.test(input.paymentId ?? '') || !UUID.test(input.orderId ?? ''))
      throw this.invalid('reference_invalid');
    if (typeof input.paymentRef !== 'string' || input.paymentRef.length === 0)
      throw this.invalid('reference_invalid');
    if (input.currency !== this.currency)
      throw this.invalid('currency_unsupported');
    // The whole captured amount goes to clearing; the commission is taken at settlement (S14.R-11).
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw this.invalid('line_amount_invalid');
    const result = await this.posting.post(
      {
        kind: 'SALE',
        reference: input.paymentId,
        currency: input.currency,
        shardKey: input.paymentId,
        fromCaller: false,
        lines: [
          {
            accountId: LEDGER_ACCOUNTS.PROVIDER_CLEARING,
            amountMinor: -input.amountMinor,
          },
          {
            accountId: LEDGER_ACCOUNTS.CLEARING,
            amountMinor: input.amountMinor,
          },
        ],
        links: {
          paymentId: input.paymentId,
          orderId: input.orderId,
          paymentRef: input.paymentRef,
          userId: input.userId || null,
          clearingMinor: input.amountMinor,
          amountMinor: input.amountMinor,
        },
      },
      tx,
    );
    return { journalId: result.journalId, created: result.created };
  }

  async refund(
    input: RefundInput,
    tx: Transaction | undefined,
  ): Promise<PaymentJournalResult> {
    if (!tx) {
      postRejectedCounter.add(1, { reason: 'transaction_required' });
      throw new TransactionRequired();
    }
    if (!UUID.test(input.paymentId ?? '') || !input.refundRef)
      throw this.invalid('reference_invalid');

    // One serialization point per payment: the settlement of the same payment takes the same lock.
    await this.journals.lockPayment(input.paymentId, tx);
    const sale = await this.journals.findByPayment('SALE', input.paymentId, tx);
    if (!sale) throw this.invalid('sale_not_found');
    const saleLines = await this.journals.entriesOf(sale.id, tx);
    const provider = saleLines.find(
      (l) => l.accountId === LEDGER_ACCOUNTS.PROVIDER_CLEARING,
    );
    const clearing = saleLines.find(
      (l) => l.accountId === LEDGER_ACCOUNTS.CLEARING,
    );
    if (!provider || !clearing) throw this.invalid('sale_not_found');
    // Sales posted before the commission moved to settlement carry a fee line of their own: reverse it with the sale.
    const legacyFee = saleLines.find(
      (l) => l.accountId === LEDGER_ACCOUNTS.PLATFORM_FEES,
    );
    if (input.currency !== sale.currency)
      throw this.invalid('journal_currency_mismatch');
    if (input.amountMinor !== -provider.amountMinor)
      throw this.invalid('refund_amount_mismatch');

    // The guards passed: a refund already posted is the answer (idempotent per payment).
    const existing = await this.journals.findByPayment(
      'REFUND',
      input.paymentId,
      tx,
    );
    if (existing) return { journalId: existing.id, created: false };

    const settlement = sale.orderId
      ? await this.journals.findSettlementByOrder(sale.orderId, tx)
      : null;
    const lines: { accountId: string; amountMinor: number; shard: number }[] = [
      { ...at(provider), amountMinor: -provider.amountMinor },
    ];
    if (legacyFee)
      lines.push({ ...at(legacyFee), amountMinor: -legacyFee.amountMinor });
    if (settlement) {
      // Settled: the clearing was already emptied; take back what the settlement paid out, the shops' shares and the commission.
      for (const credit of await this.journals.entriesOf(settlement.id, tx))
        if (credit.amountMinor > 0)
          lines.push({ ...at(credit), amountMinor: -credit.amountMinor });
    } else {
      lines.push({ ...at(clearing), amountMinor: -clearing.amountMinor });
    }

    const result = await this.posting.post(
      {
        kind: 'REFUND',
        reference: input.paymentId,
        currency: sale.currency,
        shardKey: input.paymentId,
        fromCaller: false,
        lines,
        links: refundLinks(
          sale,
          input.refundRef,
          settlement,
          input.amountMinor,
        ),
      },
      tx,
    );
    return { journalId: result.journalId, created: result.created };
  }

  private invalid(reason: JournalInvalidReason): JournalInvalid {
    postRejectedCounter.add(1, { reason });
    return new JournalInvalid(reason);
  }
}

const at = (l: StoredLine) => ({ accountId: l.accountId, shard: l.shard });

function refundLinks(
  sale: JournalHeader,
  refundRef: string,
  settlement: JournalHeader | null,
  amountMinor: number,
) {
  return {
    paymentId: sale.paymentId,
    orderId: sale.orderId,
    paymentRef: sale.paymentRef,
    refundRef,
    amountMinor,
    reversesJournalId: settlement?.id ?? null,
  };
}
