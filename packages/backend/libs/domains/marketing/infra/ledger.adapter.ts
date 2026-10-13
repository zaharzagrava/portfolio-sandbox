import { Injectable } from '@nestjs/common';
import {
  LEDGER_ACCOUNTS,
  LedgerService,
  shopAccount,
} from '@app/domains/payments';
import { TransactionRunner } from '@app/infrastructure/context';
import type { LedgerMovement, LedgerPort } from '../domain/ads-ports';

const POSTING_OPTIONS = {
  // The posting is a short, ledger-only unit of work: it must neither wait long on a hot account nor run long.
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
  propagation: 'requires_new',
} as const;

/**
 * R1 adapter for S14 (D-7, L4): `postJournal` kinds `AD_CHARGE` / `ADJUSTMENT` with a stable reference, in a
 * transaction that touches only the ledger (IX.4, FR-043), and `getBalances`. `created: false` means the reference was
 * posted before, which is success. A busy ledger (`LedgerBusy`) propagates: the job retries.
 */
@Injectable()
export class LedgerAdapter implements LedgerPort {
  constructor(
    private readonly ledger: LedgerService,
    private readonly transactions: TransactionRunner,
  ) {}

  post(
    movement: LedgerMovement,
  ): Promise<{ journalId: string; created: boolean }> {
    return this.transactions.run(
      (tx) =>
        this.ledger.postJournal(
          {
            kind: movement.kind,
            reference: movement.reference,
            currency: 'EUR',
            lines: [
              {
                accountId: shopAccount(movement.shopId),
                amountMinor: -movement.chargeMinor,
              },
              {
                accountId: LEDGER_ACCOUNTS.PLATFORM_FEES,
                amountMinor: movement.chargeMinor,
              },
            ],
          },
          tx,
        ),
      POSTING_OPTIONS,
    );
  }

  async shopBalance(shopId: string): Promise<number> {
    const account = shopAccount(shopId);
    const balances = await this.ledger.getBalances({
      accountIds: [account],
      currency: 'EUR',
    });
    return balances.get(account)?.balanceMinor ?? 0;
  }
}
