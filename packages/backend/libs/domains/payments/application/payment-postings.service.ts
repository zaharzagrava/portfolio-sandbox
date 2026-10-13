import { Inject, Injectable } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import { LEDGER_ACCOUNTS, shopIdOf } from '../domain/account';
import { splitCapture } from '../domain/fee';
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
const SUPPORTED_CURRENCY = 'EUR';

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
  ) {}

  async capture(
    input: CaptureInput,
    tx: Transaction | undefined,
  ): Promise<PaymentJournalResult> {
    if (!UUID.test(input.paymentId ?? '') || !UUID.test(input.orderId ?? ''))
      throw this.invalid('reference_invalid');
    if (typeof input.paymentRef !== 'string' || input.paymentRef.length === 0)
      throw this.invalid('reference_invalid');
    if (input.currency !== SUPPORTED_CURRENCY)
      throw this.invalid('currency_unsupported');
    let split;
    try {
      split = splitCapture(
        input.amountMinor,
        this.config.get('ledger_fee_minor'),
      );
    } catch (error) {
      if (error instanceof JournalInvalid)
        postRejectedCounter.add(1, { reason: error.reason });
      throw error;
    }
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
            amountMinor: split.providerMinor,
          },
          {
            accountId: LEDGER_ACCOUNTS.CLEARING,
            amountMinor: split.clearingMinor,
          },
          {
            accountId: LEDGER_ACCOUNTS.PLATFORM_FEES,
            amountMinor: split.feeMinor,
          },
        ],
        links: {
          paymentId: input.paymentId,
          orderId: input.orderId,
          paymentRef: input.paymentRef,
          userId: input.userId || null,
          clearingMinor: split.clearingMinor,
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
    const fees = saleLines.find(
      (l) => l.accountId === LEDGER_ACCOUNTS.PLATFORM_FEES,
    );
    if (!provider || !clearing || !fees) throw this.invalid('sale_not_found');
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
      { ...at(fees), amountMinor: -fees.amountMinor },
    ];
    if (settlement) {
      // Settled: the clearing was already emptied; take the shops' shares back instead.
      for (const share of await this.journals.entriesOf(settlement.id, tx))
        if (shopIdOf(share.accountId) && share.amountMinor > 0)
          lines.push({ ...at(share), amountMinor: -share.amountMinor });
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
