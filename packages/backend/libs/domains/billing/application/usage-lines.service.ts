import { Inject, Injectable, Logger } from '@nestjs/common';
import { Domain_UsageUnavailableError, invalidInput } from '../domain/errors';
import {
  SETTLEMENT_REPOSITORY,
  SUBSCRIPTION_REPOSITORY,
  USAGE_STORE,
  type SettlementPlan,
  type SettlementRepository,
  type SubscriptionRepository,
  type UsageInvoiceLinesProvider,
  type UsageLine,
  type UsageStorePort,
  type UsageWindow,
} from '../domain/ports';
import { planSettlement, type MetricTerms } from '../domain/usage-adjustment';
import { METRIC_PATTERN } from '../domain/usage-validation';

/** The most a renewal waits for usage (S18 FR-023, S17's 5 s). */
const MAX_TIMEOUT_MS = 5_000;

/** Rejects `usage_unavailable` when `work` does not settle within `ms`; the timer never keeps the process alive. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Domain_UsageUnavailableError()), ms);
    timer.unref();
  });
  // an abandoned (timed out) read must not become an unhandled rejection
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const validDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

/**
 * The usage lines of a renewal (S18 FR-023 to FR-027), S17's `UsageInvoiceLinesProvider`. Read-only: it measures
 * exact totals from the usage store and the settlement ledger and returns the lines plus the plan `settle` records.
 * It answers within five seconds or rejects `usage_unavailable`; invalid input is rejected before anything is read.
 */
@Injectable()
export class UsageLinesService implements UsageInvoiceLinesProvider {
  private readonly logger = new Logger(UsageLinesService.name);

  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(USAGE_STORE) private readonly store: UsageStorePort,
    @Inject(SETTLEMENT_REPOSITORY)
    private readonly ledger: SettlementRepository,
  ) {}

  async linesFor(input: {
    subscriptionId: string;
    subjectId: string;
    priceId: string;
    periodStart: Date;
    periodEnd: Date;
    measuredAt: Date;
    timeoutMs: number;
  }): Promise<{ lines: UsageLine[]; settlement: SettlementPlan }> {
    if (
      !validDate(input.periodStart) ||
      !validDate(input.periodEnd) ||
      !validDate(input.measuredAt) ||
      input.periodEnd.getTime() <= input.periodStart.getTime() ||
      typeof input.subscriptionId !== 'string' ||
      typeof input.subjectId !== 'string' ||
      typeof input.priceId !== 'string'
    )
      throw invalidInput();
    const budget = Math.min(
      Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? input.timeoutMs
        : MAX_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );
    return withTimeout(this.compute(input), budget);
  }

  private async compute(input: {
    subscriptionId: string;
    subjectId: string;
    priceId: string;
    periodStart: Date;
    periodEnd: Date;
    measuredAt: Date;
  }): Promise<{ lines: UsageLine[]; settlement: SettlementPlan }> {
    const view = await this.subscriptions.findById(input.subscriptionId);
    if (
      !view ||
      view.subscription.priceId !== input.priceId ||
      view.subscription.subjectId !== input.subjectId
    )
      throw invalidInput('The price or the subject is not the subscription’s.');

    const terms: MetricTerms[] = [];
    for (const [metric, included] of Object.entries(view.price.includedUsage)) {
      if (!METRIC_PATTERN.test(metric)) {
        this.logger.warn(
          `price ${input.priceId} includes an unknown metric; skipped`,
        );
        continue;
      }
      terms.push({
        metric,
        included,
        overagePer1000Minor: view.price.overagePer1000Minor[metric] ?? 0,
      });
    }
    terms.sort((a, b) => (a.metric < b.metric ? -1 : 1));

    const open = await this.ledger.findOpen(input.subscriptionId);
    const hasRow = (metric: string) =>
      open.some(
        (row) =>
          row.metric === metric &&
          row.periodStart.getTime() === input.periodStart.getTime(),
      );
    // the ended period of every included metric that has no ledger row yet, and the period of every open row
    const windows: UsageWindow[] = [
      ...terms
        .filter((term) => !hasRow(term.metric))
        .map((term) => ({
          metric: term.metric,
          from: input.periodStart,
          to: input.periodEnd,
        })),
      ...open.map((row) => ({
        metric: row.metric,
        from: row.periodStart,
        to: row.periodEnd,
      })),
    ];
    const totals =
      windows.length > 0
        ? await this.store.totals(input.subjectId, windows)
        : [];

    const usedInPeriod = new Map<string, number>();
    const fresh = windows.length - open.length;
    windows.slice(0, fresh).forEach((window, i) => {
      usedInPeriod.set(window.metric, totals[i]);
    });
    return planSettlement({
      period: { start: input.periodStart, end: input.periodEnd },
      terms,
      usedInPeriod,
      openRows: open.map((row, i) => ({ row, total: totals[fresh + i] })),
      measuredAt: input.measuredAt,
    });
  }
}
