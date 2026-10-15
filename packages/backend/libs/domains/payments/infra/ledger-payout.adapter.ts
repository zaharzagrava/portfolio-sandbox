import { Injectable } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import { LedgerService } from '../application/ledger.service';
import { LEDGER_ACCOUNTS, shopAccount } from '../domain/account';
import { InsufficientBalance, LedgerBusy } from '../domain/ledger-errors';
import {
  PayoutLedgerRefusal,
  PayoutLedgerUnavailable,
  type PayoutLedgerPort,
} from '../domain/payout-ports';

/**
 * The payouts' narrow view of the ledger (S15 contracts/services.md): `postJournal` for the three payout postings,
 * `getBalances` and `listSellerBalances` for reading. A refusal the payout run has to tell apart becomes
 * `PayoutLedgerRefusal`; any other error propagates and rolls the caller's transaction back.
 */
@Injectable()
export class LedgerPayoutAdapter implements PayoutLedgerPort {
  constructor(private readonly ledger: LedgerService) {}

  async listSellerBalances(input: {
    currency: string;
    minMinor: number;
    limit: number;
    after?: string;
  }) {
    try {
      return await this.ledger.listSellerBalances(input);
    } catch (error) {
      throw new PayoutLedgerUnavailable({ cause: error });
    }
  }

  async balances(
    shopIds: string[],
    currency: string,
    tx?: Transaction,
  ): Promise<Map<string, number>> {
    const accounts = shopIds.map(shopAccount);
    const found = await this.ledger.getBalances(
      { accountIds: accounts, currency },
      tx,
    );
    return new Map(
      shopIds.map((id) => [id, found.get(shopAccount(id))?.balanceMinor ?? 0]),
    );
  }

  async postCreated(
    p: { id: string; shopId: string; amountMinor: number; currency: string },
    tx: Transaction,
  ): Promise<void> {
    await this.post(
      {
        kind: 'PAYOUT',
        reference: p.id,
        currency: p.currency,
        lines: [
          { accountId: shopAccount(p.shopId), amountMinor: -p.amountMinor },
          {
            accountId: LEDGER_ACCOUNTS.PAYOUT_CLEARING,
            amountMinor: p.amountMinor,
          },
        ],
      },
      tx,
    );
  }

  async postSent(
    p: { id: string; amountMinor: number; currency: string },
    tx: Transaction,
  ): Promise<void> {
    await this.post(
      {
        kind: 'PAYOUT',
        reference: `${p.id}:sent`,
        currency: p.currency,
        lines: [
          {
            accountId: LEDGER_ACCOUNTS.PAYOUT_CLEARING,
            amountMinor: -p.amountMinor,
          },
          {
            accountId: LEDGER_ACCOUNTS.PAYOUTS_SENT,
            amountMinor: p.amountMinor,
          },
        ],
      },
      tx,
    );
  }

  async postReversal(
    p: { id: string; shopId: string; amountMinor: number; currency: string },
    tx: Transaction,
  ): Promise<void> {
    await this.post(
      {
        kind: 'PAYOUT_REVERSAL',
        reference: p.id,
        currency: p.currency,
        lines: [
          {
            accountId: LEDGER_ACCOUNTS.PAYOUT_CLEARING,
            amountMinor: -p.amountMinor,
          },
          { accountId: shopAccount(p.shopId), amountMinor: p.amountMinor },
        ],
      },
      tx,
    );
  }

  private async post(
    input: Parameters<LedgerService['postJournal']>[0],
    tx: Transaction,
  ): Promise<void> {
    try {
      await this.ledger.postJournal(input, tx);
    } catch (error) {
      if (error instanceof InsufficientBalance)
        throw new PayoutLedgerRefusal('insufficient_balance');
      if (error instanceof LedgerBusy)
        throw new PayoutLedgerRefusal('ledger_busy');
      throw error;
    }
  }
}
