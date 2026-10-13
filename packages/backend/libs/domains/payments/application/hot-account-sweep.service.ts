import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { HOT_ACCOUNTS } from '../domain/account';
import {
  BALANCE_STORE,
  JOURNAL_STORE,
  type BalanceStore,
  type JournalStore,
} from '../domain/ledger-ports';
import { JournalPostingService } from './journal-posting.service';

export interface SweepResult {
  accountId: string;
  journalId: string | null;
  created: boolean;
  shards: number;
}

const CURRENCY = 'EUR';
/** A journal has at most 200 lines: one for shard 0 and up to 199 shards to empty per sweep. */
const MAX_SHARDS_PER_SWEEP = 199;

/** Start of the UTC hour of `at`, as the ISO string that names a sweep window. */
export const sweepWindow = (at: Date): string => {
  const d = new Date(at.getTime());
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
};

/**
 * Consolidates the non-empty shards of the three hot accounts into shard 0 (S14 FR-019, research R-5): per account one
 * balanced `SWEEP` journal per window, in one transaction. Re-running a window changes nothing (the journal is unique
 * on its reference). Moves exactly the amounts it read, with relative increments, so a posting that lands on a shard
 * meanwhile is neither lost nor counted twice; whatever is left is taken by the next window.
 */
@Injectable()
export class HotAccountSweepService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly posting: JournalPostingService,
    @Inject(BALANCE_STORE) private readonly balances: BalanceStore,
    @Inject(JOURNAL_STORE) private readonly journals: JournalStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async sweepAll(window?: string): Promise<SweepResult[]> {
    const windowStart = window ?? sweepWindow(this.clock.now());
    const results: SweepResult[] = [];
    for (const accountId of HOT_ACCOUNTS)
      results.push(await this.sweepAccount(accountId, windowStart));
    return results;
  }

  private sweepAccount(
    accountId: string,
    window: string,
  ): Promise<SweepResult> {
    const reference = `${accountId}:${window}`;
    return this.transactions.run(async (tx) => {
      const done = await this.journals.findHeader('SWEEP', reference, tx);
      if (done)
        return { accountId, journalId: done.id, created: false, shards: 0 };

      const shards = (
        await this.balances.sweepableShards(accountId, CURRENCY, tx)
      ).slice(0, MAX_SHARDS_PER_SWEEP);
      if (shards.length === 0)
        return { accountId, journalId: null, created: false, shards: 0 };

      const total = shards.reduce((s, x) => s + x.balanceMinor, 0);
      const result = await this.posting.post(
        {
          kind: 'SWEEP',
          reference,
          currency: CURRENCY,
          fromCaller: false,
          lines: [
            ...shards.map((s) => ({
              accountId,
              shard: s.shard,
              amountMinor: -s.balanceMinor,
            })),
            // shards that cancel each other out leave nothing to credit to shard 0
            ...(total === 0
              ? []
              : [{ accountId, shard: 0, amountMinor: total }]),
          ],
        },
        tx,
      );
      return {
        accountId,
        journalId: result.journalId,
        created: result.created,
        shards: shards.length,
      };
    });
  }
}
