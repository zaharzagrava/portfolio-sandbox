import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  BALANCE_DURABLE_STORE,
  BALANCE_HOT_STORE,
  LEDGER_MAINTENANCE_STORE,
  type BalanceReadModelStore,
  type LedgerMaintenanceStore,
} from '../domain/ledger-ports';

export const BACKFILL_BATCH = 5_000;
const DAY_MS = 86_400_000;
const SEED_PAGE = 1_000;

export interface BackfillResult {
  batches: number;
  rows: number;
  finished: boolean;
}

/**
 * The backfill of the expand/contract migration (S14 FR-045, data-model "Migration sequence" step 4): existing entries
 * get a journal header and the running balances are built from them, in keyset batches of 5 000 rows, each its own
 * transaction with a 3 s lock limit, resumable from a cursor row and idempotent (a journal is booked by whichever
 * batch meets it first; a header that exists is never booked twice). Legacy buyer-account lines stay as history with
 * their own balance rows. When the last batch is done it seeds the checkpoints and the read model.
 */
@Injectable()
export class BalanceBackfillService {
  private readonly logger = new Logger(BalanceBackfillService.name);

  constructor(
    @Inject(LEDGER_MAINTENANCE_STORE)
    private readonly store: LedgerMaintenanceStore,
    @Inject(BALANCE_HOT_STORE) private readonly hot: BalanceReadModelStore,
    @Inject(BALANCE_DURABLE_STORE)
    private readonly durable: BalanceReadModelStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(
    options: {
      batch?: number;
      maxBatches?: number;
      signal?: AbortSignal;
      heartbeat?: () => Promise<void>;
    } = {},
  ): Promise<BackfillResult> {
    if (await this.store.backfillFinished())
      return { batches: 0, rows: 0, finished: true };
    const batch = options.batch ?? BACKFILL_BATCH;
    let batches = 0;
    let rows = 0;
    let finished = false;
    while (!options.signal?.aborted) {
      const result = await this.store.backfillBatch({
        batch,
        now: this.clock.now(),
      });
      if (result.rows === 0) {
        finished = true;
        break;
      }
      batches++;
      rows += result.rows;
      await options.heartbeat?.();
      if (options.maxBatches && batches >= options.maxBatches) break;
    }
    if (finished) await this.finish();
    this.logger.log(
      `backfill: ${batches} batches, ${rows} rows${finished ? ', finished' : ''}`,
    );
    return { batches, rows, finished };
  }

  private async finish(): Promise<void> {
    const now = this.clock.now();
    await this.store.seedCheckpoints(
      new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS),
    );
    let after: { accountId: string; shard: number; currency: string } | null =
      null;
    for (;;) {
      const page = await this.store.balancePage(after, SEED_PAGE);
      if (page.length === 0) break;
      for (const row of page) {
        if (row.accountId.startsWith('MERCHANT_')) continue; // buyer accounts of the old shape: history only
        const line = { ...row, projectedAt: now };
        await this.durable.putIfNewer(line);
        await this.hot.putIfNewer(line);
      }
      after = page[page.length - 1];
      if (page.length < SEED_PAGE) break;
    }
    await this.store.markBackfillFinished(now);
  }
}
