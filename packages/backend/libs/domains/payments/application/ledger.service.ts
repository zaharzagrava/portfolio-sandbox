import { Inject, Injectable } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { Fatal_BadRequestError } from '@app/common/errors';
import { parseAccountId, shopIdOf } from '../domain/account';
import { CALLER_KINDS, type JournalLineInput } from '../domain/journal';
import { JournalInvalid } from '../domain/ledger-errors';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  isAccountCursor,
} from '../domain/ledger-cursor';
import { BALANCE_STORE, type BalanceStore } from '../domain/ledger-ports';
import { ledgerCursorSecret } from './cursor-secret';
import { JournalPostingService } from './journal-posting.service';
import {
  PaymentPostingsService,
  type CaptureInput,
  type RefundInput,
} from './payment-postings.service';

export type CallerJournalKind = (typeof CALLER_KINDS)[number];

export interface PostJournalInput {
  kind: CallerJournalKind;
  reference: string;
  currency: string;
  lines: JournalLineInput[];
}

export interface PostedJournal {
  journalId: string;
  created: boolean;
}

const MAX_ACCOUNTS = 500;
const MAX_SELLER_PAGE = 200;

/**
 * The R1 facade of the ledger (S14 contracts/services.md): plain values in and out, no model, no HTTP type. Every
 * posting joins the caller's transaction. Reads never sum entries: they read the running balances.
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly posting: JournalPostingService,
    private readonly payments: PaymentPostingsService,
    @Inject(BALANCE_STORE) private readonly balances: BalanceStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  /**
   * Books a captured payment (FR-013): one `SALE` journal per payment, in the caller's transaction. A repeat returns
   * the existing journal; the same payment with another amount is a `JournalConflict`.
   */
  recordPaymentCaptured(
    input: CaptureInput,
    tx: Transaction,
  ): Promise<PostedJournal> {
    return this.payments.capture(input, tx);
  }

  /** The exact reversal of a sale (FR-014), including the shops' shares when the order was settled. */
  recordPaymentRefunded(
    input: RefundInput,
    tx: Transaction,
  ): Promise<PostedJournal> {
    return this.payments.refund(input, tx);
  }

  /** For the four kinds callers own: `PAYOUT`, `PAYOUT_REVERSAL`, `AD_CHARGE`, `ADJUSTMENT` (FR-008). */
  async postJournal(
    input: PostJournalInput,
    tx: Transaction,
  ): Promise<PostedJournal> {
    const { journalId, created } = await this.posting.post(
      {
        kind: input.kind,
        reference: input.reference,
        currency: input.currency,
        lines: input.lines,
        fromCaller: true,
      },
      tx,
    );
    return { journalId, created };
  }

  /** Authoritative balances of up to 500 accounts; an account without a row is `0`. Honours the caller's `tx`. */
  async getBalances(
    input: { accountIds: string[]; currency: string },
    tx?: Transaction,
  ): Promise<Map<string, { balanceMinor: number; asOf: Date }>> {
    if (!/^[A-Z]{3}$/.test(input.currency))
      throw new JournalInvalid('currency_invalid');
    const wanted = [...new Set(input.accountIds)];
    if (wanted.length > MAX_ACCOUNTS)
      throw new JournalInvalid('too_many_accounts');
    const canonical = wanted.map((id) => parseAccountId(id)?.id ?? id);
    const stored = await this.balances.read(
      [...new Set(canonical)],
      input.currency,
      tx,
    );
    const asOf = this.clock.now();
    return new Map(
      wanted.map((id, i) => [
        id,
        { balanceMinor: stored.get(canonical[i]) ?? 0, asOf },
      ]),
    );
  }

  /** Seller accounts with at least `minMinor`, by keyset on the account id with a signed cursor (FR-023). */
  async listSellerBalances(input: {
    currency: string;
    minMinor: number;
    limit: number;
    after?: string;
  }): Promise<{
    items: { shopId: string; balanceMinor: number }[];
    next: string | null;
  }> {
    if (!/^[A-Z]{3}$/.test(input.currency))
      throw new JournalInvalid('currency_invalid');
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_SELLER_PAGE ||
      !Number.isSafeInteger(input.minMinor)
    )
      throw new Fatal_BadRequestError({
        detail: `limit must be an integer from 1 to ${MAX_SELLER_PAGE}`,
      });
    const secret = this.cursorSecret();
    const after =
      input.after === undefined
        ? undefined
        : decodeLedgerCursor(input.after, secret, isAccountCursor).a;
    const rows = await this.balances.listSellers({
      currency: input.currency,
      minMinor: input.minMinor,
      limit: input.limit + 1,
      after,
    });
    const page = rows.slice(0, input.limit);
    return {
      items: page.map((r) => ({
        shopId: shopIdOf(r.accountId)!,
        balanceMinor: r.balanceMinor,
      })),
      next:
        rows.length > input.limit
          ? encodeLedgerCursor({ a: page[page.length - 1].accountId }, secret)
          : null,
    };
  }

  private cursorSecret(): string {
    return ledgerCursorSecret(this.config);
  }
}
