import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  PROVIDER_STATEMENT,
  ProviderUnavailableError,
  RECONCILIATION_STORE,
  type OpenMissingIssue,
  type ProviderStatement,
  type ReconciliationStore,
  type RunRecord,
} from '../domain/ledger-ports';
import {
  reconciliationLinesSkippedCounter,
  reconciliationRunsCounter,
} from '../domain/ledger-metrics';
import {
  DuplicateTracker,
  ISSUE_KINDS,
  classifyLine,
  classifyMissingAtProvider,
  parseStatementLine,
  type LedgerSide,
  type MatchIssue,
  type StatementLine,
} from '../domain/reconciliation-matcher';
import { dayWindow } from '../domain/reconciliation-window';
import {
  ReconciliationCompleted,
  ReconciliationIssueOpened,
} from './events/ledger-events';
import { ReconciliationGauges } from './reconciliation-gauges.service';

export const RECONCILIATION_PROVIDER = 'stripe';
/** The job lease (S49) and the run lease are the same ten minutes; a heartbeat renews both. */
const LEASE_MS = 600_000;
/** The job's lease is renewed at least this often while a statement streams (FR-029). */
const HEARTBEAT_EVERY_LINES = 1_000;
const RECHECK_DAYS = 3;
const DAY_MS = 86_400_000;

export interface RunOptions {
  /** The job layer's lease renewal (S49 `ctx.heartbeat`). */
  heartbeat?: () => Promise<void>;
  /** Aborted by the job layer on shutdown or lease loss. */
  signal?: AbortSignal;
  /** Called after page `n` was fully processed (the proof of backpressure reads it). */
  onPageProcessed?: (page: number) => void;
}

export type RunOutcome =
  | {
      outcome: 'completed';
      run: RunRecord;
      opened: number;
      autoResolved: number;
    }
  | { outcome: 'already_completed'; run: RunRecord }
  | { outcome: 'already_running'; run: RunRecord }
  | { outcome: 'interrupted'; run: RunRecord };

export class RunLeaseLostError extends Error {
  constructor(runId: string) {
    super(`reconciliation run ${runId} lost its lease`);
    this.name = 'RunLeaseLostError';
  }
}

const key = (kind: string, reference: string) => `${kind}:${reference}`;
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

/**
 * One reconciliation run per (provider, UTC day) (S14 FR-028…FR-037, research R-9): the statement is read page by page
 * with the next page requested only after the previous one is processed; each line is validated, matched to the
 * ledger's `SALE`/`REFUND` headers by provider reference, and differences are staged; journals of the day the
 * statement never showed are looked up at the provider (a day boundary is not an issue); open timing issues of the
 * previous three days are re-checked; then ONE transaction promotes the issues, closes the auto-matched ones, marks
 * the run `COMPLETED` and outboxes the events. Any failure before that leaves a `FAILED` run and no issue. It never
 * posts to the ledger.
 */
@Injectable()
export class ReconciliationRunService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationRunService.name);
  private stopping = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    @Inject(RECONCILIATION_STORE) private readonly store: ReconciliationStore,
    @Inject(PROVIDER_STATEMENT) private readonly statement: ProviderStatement,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly gauges: ReconciliationGauges,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly shutdown?: ShutdownRegistry,
  ) {}

  onApplicationBootstrap(): void {
    this.shutdown?.register({
      name: 'ledger.reconciliation-runner',
      order: 10, // stop intake first
      timeoutMs: 9_000,
      run: () => this.drain(),
    });
  }

  /**
   * On the stop signal no further page is requested; the run in flight ends as `FAILED(interrupted)` (its lease would
   * expire otherwise) and the next attempt restarts the day.
   */
  async drain(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.inFlight]);
  }

  runDay(day: string, options: RunOptions = {}): Promise<RunOutcome> {
    const running = this.runDayNow(day, options);
    this.inFlight.add(running);
    const forget = () => void this.inFlight.delete(running);
    running.then(forget, forget);
    return running;
  }

  private async runDayNow(
    day: string,
    options: RunOptions,
  ): Promise<RunOutcome> {
    const now = this.clock.now();
    const claim = await this.store.claim({
      provider: RECONCILIATION_PROVIDER,
      day,
      now,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
    });
    if (claim.kind === 'completed')
      return { outcome: 'already_completed', run: claim.run };
    if (claim.kind === 'running')
      return { outcome: 'already_running', run: claim.run };

    const run = claim.run;
    try {
      return await this.execute(run, options);
    } catch (error) {
      const code =
        error instanceof ProviderUnavailableError
          ? 'provider_unavailable'
          : 'internal';
      await this.store
        .failRun(run, code, this.clock.now())
        .catch(() => undefined);
      reconciliationRunsCounter.add(1, { status: 'failed' });
      this.logger.error(
        `reconciliation of ${run.day} failed (${code}) run ${run.id}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  private async execute(
    run: RunRecord,
    options: RunOptions,
  ): Promise<RunOutcome> {
    const { fromInclusive, toExclusive } = dayWindow(run.day);
    const counts = {
      providerLines: 0,
      ledgerJournals: 0,
      matched: 0,
      skipped: 0,
    };
    const tracker = new DuplicateTracker();
    const pageSize = this.config.get('reconciliation_page_size');
    let position = 0;
    let sinceBeat = 0;
    let page = 0;
    let cursor: string | null = null;

    do {
      if (this.interrupted(options)) return this.interrupt(run);
      const result = await this.statement.listLines({
        fromInclusive,
        toExclusive,
        cursor,
        limit: pageSize,
      });
      page++;
      const fresh: StatementLine[] = [];
      const staged: MatchIssue[] = [];
      for (const raw of result.lines) {
        position++;
        const parsed = parseStatementLine(raw, position);
        if (parsed.kind === 'invalid') {
          counts.providerLines++;
          staged.push({
            kind: 'INVALID_PROVIDER_RECORD',
            reference: `position:${position}`,
            details: { position },
          });
        } else if (parsed.kind === 'skipped') {
          counts.providerLines++;
          counts.skipped++;
          reconciliationLinesSkippedCounter.add(1, { type: parsed.type });
        } else {
          const seen = tracker.add(parsed.line);
          if (seen.result === 'repeat') continue; // a page that repeats an earlier line counts it once
          counts.providerLines++;
          if (seen.result === 'duplicate') staged.push(seen.issue);
          else fresh.push(parsed.line);
        }
      }

      const references = [
        ...new Set(
          fresh.filter((l) => l.type !== 'dispute').map((l) => l.reference),
        ),
      ];
      const sides = new Map<string, LedgerSide>(
        (await this.store.ledgerSides(references)).map((s) => [
          key(s.kind, s.reference),
          s,
        ]),
      );
      for (const line of fresh) {
        const side =
          line.type === 'dispute'
            ? undefined
            : sides.get(
                key(line.type === 'refund' ? 'REFUND' : 'SALE', line.reference),
              );
        const outcome = classifyLine(line, side);
        if (outcome.outcome === 'matched') counts.matched++;
        else staged.push(outcome.issue);
      }
      await this.store.stageIssues(run.id, staged);
      await this.store.markSeen(run.id, [
        ...new Set(fresh.map((l) => l.reference)),
      ]);
      options.onPageProcessed?.(page);

      sinceBeat += result.lines.length;
      if (sinceBeat >= HEARTBEAT_EVERY_LINES) {
        sinceBeat = 0;
        await this.beat(run, options);
      }
      cursor = result.nextCursor;
    } while (cursor);

    // Our side: the day's journals the statement never showed. The provider is asked for each by reference, so a
    // charge that fell on the other side of midnight is not reported missing.
    counts.ledgerJournals = await this.store.countDayJournals(
      fromInclusive,
      toExclusive,
    );
    let afterId: string | null = null;
    for (;;) {
      if (this.interrupted(options)) return this.interrupt(run);
      const unseen = await this.store.unseenJournals({
        runId: run.id,
        fromInclusive,
        toExclusive,
        afterId,
        limit: pageSize,
      });
      if (unseen.length === 0) break;
      const missing: MatchIssue[] = [];
      for (const journal of unseen) {
        const found = await this.statement.findByReference(journal.reference);
        if (found === null) missing.push(classifyMissingAtProvider(journal));
      }
      await this.store.stageIssues(run.id, missing);
      afterId = unseen[unseen.length - 1].id;
      await this.beat(run, options);
    }

    const resolved = await this.recheck(run.day);
    if (this.interrupted(options)) return this.interrupt(run);

    const now = this.clock.now();
    const done = await this.transactions.run(async (tx) => {
      const opened = await this.store.promoteStaged(run, now, tx);
      const autoResolved = await this.store.autoResolve(resolved, now, tx);
      const finished = await this.store.finishRun(run, counts, now, tx);
      if (!finished) throw new RunLeaseLostError(run.id);
      await this.store.purgeScratch(run.id, tx);
      await this.outbox.append(
        [
          ...opened.map((i) =>
            ReconciliationIssueOpened.create(i.id, 1, {
              issueId: i.id,
              runId: run.id,
              day: run.day,
              kind: i.kind as (typeof ISSUE_KINDS)[number],
              reference: i.reference,
            }),
          ),
          ReconciliationCompleted.create(run.id, 1, {
            runId: run.id,
            provider: run.provider,
            day: run.day,
            status: 'COMPLETED',
            matched: counts.matched,
            issueCount: finished.issues,
          }),
        ],
        tx,
      );
      return {
        opened: opened.length,
        autoResolved: autoResolved.length,
        issues: finished.issues,
      };
    });

    reconciliationRunsCounter.add(1, { status: 'completed' });
    this.logger.log(
      `reconciliation of ${run.day} completed, run ${run.id}: ${counts.matched} matched, ${done.issues} issues`,
    );
    await this.gauges.refresh();
    return {
      outcome: 'completed',
      run: {
        ...run,
        status: 'COMPLETED',
        ...counts,
        issues: done.issues,
        finishedAt: now,
      },
      opened: done.opened,
      autoResolved: done.autoResolved,
    };
  }

  /** Open `MISSING_*` issues of the previous three days that now match (AS-49): the ids to close as `auto_matched`. */
  private async recheck(day: string): Promise<string[]> {
    const open = await this.store.openMissingIssues(
      addDays(day, -RECHECK_DAYS),
      day,
    );
    if (open.length === 0) return [];
    const inLedger = open.filter(
      (i) => i.kind === 'MISSING_IN_LEDGER' && i.details.type !== 'dispute',
    );
    const sides = new Map<string, LedgerSide>(
      (await this.store.ledgerSides(inLedger.map((i) => i.reference))).map(
        (s) => [key(s.kind, s.reference), s],
      ),
    );
    const resolved: string[] = [];
    for (const issue of open) {
      if (await this.nowMatches(issue, sides)) resolved.push(issue.id);
    }
    return resolved;
  }

  private async nowMatches(
    issue: OpenMissingIssue,
    sides: Map<string, LedgerSide>,
  ): Promise<boolean> {
    if (issue.kind === 'MISSING_AT_PROVIDER')
      return (await this.statement.findByReference(issue.reference)) !== null;
    if (issue.details.type === 'dispute') return false;
    const side = sides.get(
      key(issue.details.type === 'refund' ? 'REFUND' : 'SALE', issue.reference),
    );
    return (
      !!side &&
      side.amountMinor === issue.details.providerAmount &&
      side.currency === issue.details.currency
    );
  }

  private async beat(run: RunRecord, options: RunOptions): Promise<void> {
    await options.heartbeat?.();
    const renewed = await this.store.extendLease(
      run,
      new Date(this.clock.now().getTime() + LEASE_MS),
    );
    if (!renewed) throw new RunLeaseLostError(run.id);
  }

  private interrupted(options: RunOptions): boolean {
    return this.stopping || options.signal?.aborted === true;
  }

  private async interrupt(run: RunRecord): Promise<RunOutcome> {
    await this.store.failRun(run, 'interrupted', this.clock.now());
    reconciliationRunsCounter.add(1, { status: 'failed' });
    return {
      outcome: 'interrupted',
      run: { ...run, status: 'FAILED', failureCode: 'interrupted' },
    };
  }
}
