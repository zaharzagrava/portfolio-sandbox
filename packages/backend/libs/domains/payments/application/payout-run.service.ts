import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import {
  PAYOUT_DESTINATION_REPOSITORY,
  PAYOUT_LEDGER,
  PAYOUT_RESERVE_REPOSITORY,
  PAYOUT_RUN_REPOSITORY,
  PayoutLedgerUnavailable,
  SHOP_SUMMARY_PORT,
  type PayoutDestinationRepository,
  type PayoutLedgerPort,
  type PayoutReserveRepository,
  type PayoutRunRepository,
  type ShopSummaryPort,
} from '../domain/payout-ports';
import { assessEligibility } from '../domain/eligibility';
import { RunRefused } from '../domain/payout-errors';
import {
  payoutCreatedCounter,
  payoutRunCounter,
  payoutRunDurationHistogram,
  payoutSkippedCounter,
} from '../domain/payout-metrics';
import { periodStartOf, validatePeriod } from '../domain/period';
import {
  PAYOUT_CURRENCY,
  PayoutCreationService,
} from './payout-creation.service';

const PAGE = 200;

export interface RunSummary {
  periodStart: string;
  status: 'COMPLETED' | 'FAILED';
  created: number;
  existing: number;
  skipped: Record<string, number>;
  failureCode: string | null;
}

/**
 * The weekly payout run (S15 FR-001…FR-010, FR-049): validate the period, record the run, page the sellers by keyset,
 * check the gates per page in batches (tenancy, destinations, reserves), then one atomic creation step per shop with
 * the shop's own failure isolated. A stop request (the job's signal or the shutdown registry) ends the run between
 * shops, never inside one. Re-running a period adds only what is missing.
 */
@Injectable()
export class PayoutRunService {
  private readonly logger = new Logger(PayoutRunService.name);
  private stopRequested = false;
  private active: Promise<unknown> | null = null;

  constructor(
    @Inject(PAYOUT_RUN_REPOSITORY) private readonly runs: PayoutRunRepository,
    @Inject(PAYOUT_LEDGER) private readonly ledger: PayoutLedgerPort,
    @Inject(SHOP_SUMMARY_PORT) private readonly shops: ShopSummaryPort,
    @Inject(PAYOUT_DESTINATION_REPOSITORY)
    private readonly destinations: PayoutDestinationRepository,
    @Inject(PAYOUT_RESERVE_REPOSITORY)
    private readonly reserves: PayoutReserveRepository,
    private readonly creation: PayoutCreationService,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    shutdown?.register({
      name: 'payouts.run.stop',
      order: 10,
      run: async () => {
        this.stopRequested = true;
        await this.active?.catch(() => undefined);
      },
    });
  }

  async run(input: {
    periodStart?: unknown;
    signal?: AbortSignal;
  }): Promise<RunSummary> {
    const started = this.clock.now();
    const checked = validatePeriod(
      input.periodStart ?? periodStartOf(started),
      started,
    );
    if (!checked.ok) throw new RunRefused();
    const { periodStart } = checked;

    const execution = this.execute(periodStart, input.signal, started);
    this.active = execution;
    try {
      return await execution;
    } finally {
      this.active = null;
    }
  }

  private async execute(
    periodStart: string,
    signal: AbortSignal | undefined,
    started: Date,
  ): Promise<RunSummary> {
    await this.runs.start(periodStart, started);
    const skipped: Record<string, number> = {};
    let created = 0;
    let existing = 0;
    const skip = (reason: string) => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      payoutSkippedCounter.add(1, { reason });
    };
    const finish = async (
      status: 'COMPLETED' | 'FAILED',
      failureCode: string | null,
    ): Promise<RunSummary> => {
      const now = this.clock.now();
      await this.runs.finish(
        periodStart,
        { status, created, existing, skipped, failureCode },
        now,
      );
      payoutRunCounter.add(1, { status });
      payoutRunDurationHistogram.record(
        Math.max(0, now.getTime() - started.getTime()) / 1000,
      );
      this.logger.log(
        JSON.stringify({
          event: 'payout.run.finished',
          periodStart,
          status,
          failureCode,
          created,
          existing,
          skipped,
        }),
      );
      return { periodStart, status, created, existing, skipped, failureCode };
    };

    const minMinor = this.config.get('payout_min_minor');
    const defaultBps = this.config.get('payout_default_reserve_bps');
    const stopped = () => this.stopRequested || signal?.aborted === true;

    let after: string | undefined;
    do {
      if (stopped()) return finish('FAILED', 'interrupted');
      let page;
      try {
        page = await this.ledger.listSellerBalances({
          currency: PAYOUT_CURRENCY,
          minMinor,
          limit: PAGE,
          after,
        });
      } catch (error) {
        if (!(error instanceof PayoutLedgerUnavailable)) throw error;
        await finish('FAILED', 'ledger_unavailable');
        throw error;
      }

      const ids = page.items.map((i) => i.shopId);
      const [summaries, destinations, reserves] = ids.length
        ? await Promise.all([
            this.shops.getSummaries(ids),
            this.destinations.findMany(ids),
            this.reserves.findMany(ids),
          ])
        : [new Map(), new Map(), new Map()];

      for (const { shopId } of page.items) {
        if (stopped()) return finish('FAILED', 'interrupted');
        const summary = summaries.get(shopId);
        const destination = destinations.get(shopId) ?? null;
        const gate = assessEligibility({
          known: summary !== undefined,
          status: summary?.status,
          payoutsEnabled: summary?.payoutsEnabled ?? false,
          destination,
          now: this.clock.now(),
        });
        if (!gate.ok) {
          skip(gate.reason);
          continue;
        }
        try {
          const result = await this.creation.createFor(shopId, periodStart, {
            reserveBps: reserves.get(shopId)?.reserveBps ?? defaultBps,
            destination: destination!.providerAccountId,
          });
          if (result === 'created') {
            created += 1;
            payoutCreatedCounter.add(1);
          } else if (result === 'existing') existing += 1;
          else skip(result.skipped);
        } catch (error) {
          // One shop's failure never stops the others; the next run retries it (nothing of it was committed).
          skip('internal_error');
          this.logger.error(
            `payout creation failed for shop ${shopId}: ${(error as Error).name}`,
          );
        }
      }
      after = page.next ?? undefined;
    } while (after);

    return finish('COMPLETED', null);
  }
}
