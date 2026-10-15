import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ReconciliationFindingPage } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ApiConfigService } from '@app/common/config';
import { TransactionRunner } from '@app/infrastructure/context';
import { STATEMENTS_CONFIG, type StatementsConfig } from '../domain/config';
import { decodeCursor, encodeCursor } from '../domain/cursor';
import { monthNotAvailable } from '../domain/errors';
import {
  completenessViolationsCounter,
  findingsCounter,
} from '../domain/metrics';
import { isMonthAvailable, monthBounds } from '../domain/period';
import {
  ADJUSTMENT_REPOSITORY,
  FINDING_REPOSITORY,
  PERIOD_REPOSITORY,
  SNAPSHOT_REPOSITORY,
  STATEMENT_READER,
  type AdjustmentRepository,
  type FindingRepository,
  type PeriodRepository,
  type SnapshotRepository,
  type StatementReader,
} from '../domain/ports';
import {
  completenessFinding,
  feeFindings,
  missingInLedgerFindings,
  missingInStatementFindings,
  netFindings,
  type FindingDraft,
  type FindingKind,
} from '../domain/reconciliation';
import { isZeroResidual, residualOf } from '../domain/residual';
import './statements.job-types';

const ALL_KINDS: FindingKind[] = [
  'net_mismatch',
  'fee_mismatch',
  'missing_in_ledger',
  'missing_in_statement',
  'completeness_violation',
];
const DAY_MS = 86_400_000;
const COMPLETENESS_WINDOW_DAYS = 90;
const SNAPSHOT_PAGE = 500;

/**
 * Closed numbers proven against the ledger and against themselves (S16 FR-043..FR-045, research R-8). Every check reads
 * the statements' own tables; a finding is opened once per (month, kind, shop), cleared when a later run agrees, and a
 * snapshot is never touched. The daily run covers the closed months of the last 90 days.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly runner: TransactionRunner,
    @Inject(PERIOD_REPOSITORY) private readonly periods: PeriodRepository,
    @Inject(SNAPSHOT_REPOSITORY) private readonly snapshots: SnapshotRepository,
    @Inject(ADJUSTMENT_REPOSITORY) private readonly adjustments: AdjustmentRepository,
    @Inject(STATEMENT_READER) private readonly reader: StatementReader,
    @Inject(FINDING_REPOSITORY) private readonly findings: FindingRepository,
    private readonly config: ApiConfigService,
    @Inject(STATEMENTS_CONFIG) private readonly settings: StatementsConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async verifyPeriod(month: string): Promise<{ opened: number } | 'skipped'> {
    const period = await this.periods.find(month);
    if (!period || period.status !== 'CLOSED') return 'skipped';
    const now = this.clock.now();
    const comparison = await this.findings.ledgerComparison(month);
    const graceOver =
      period.closedAt !== null &&
      now.getTime() >= period.closedAt.getTime() + this.settings.ledgerGraceHours * 3_600_000;

    const drafts: FindingDraft[] = [
      ...netFindings(comparison.net),
      ...(comparison.fees
        ? feeFindings(comparison.fees.expectedMinor, comparison.fees.actualMinor)
        : []),
      ...(graceOver ? missingInLedgerFindings(comparison.unjournalled) : []),
      ...missingInStatementFindings(comparison.journalsWithoutSale),
      ...(await this.completeness(month, now)),
    ];
    if (comparison.unlinkedJournals > 0)
      this.logger.warn(
        `${month}: ${comparison.unlinkedJournals} sale journal(s) carry no order and were skipped`,
      );

    const opened = await this.runner.run(async () => {
      const fresh = await this.findings.sync(month, ALL_KINDS, drafts, now);
      await this.findings.markVerified(month, now);
      return fresh;
    });
    for (const finding of opened) {
      findingsCounter.add(1, { kind: finding.kind });
      if (finding.kind === 'completeness_violation')
        completenessViolationsCounter.add();
    }
    return { opened: opened.length };
  }

  /** The daily run: every closed month whose end lies within the last 90 days; one month failing does not stop the rest. */
  async verifyRecent(): Promise<number> {
    const now = this.clock.now();
    const since = now.getTime() - COMPLETENESS_WINDOW_DAYS * DAY_MS;
    let verified = 0;
    for (const row of await this.periods.list(null, 200)) {
      if (row.status !== 'CLOSED') continue;
      if (monthBounds(row.month).end.getTime() < since) continue;
      try {
        if ((await this.verifyPeriod(row.month)) !== 'skipped') verified++;
      } catch (error) {
        this.logger.error(`verification of ${row.month} failed: ${(error as Error).name}`);
      }
    }
    return verified;
  }

  /** Snapshot plus the adjustments that refer to the month against a recomputation now, per shop (FR-029). */
  private async completeness(month: string, now: Date): Promise<FindingDraft[]> {
    const drafts: FindingDraft[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await this.snapshots.page(month, after, SNAPSHOT_PAGE);
      if (page.length === 0) break;
      for (const snapshot of page) {
        const [fresh, earlier] = await Promise.all([
          this.reader.aggregate({ shopId: snapshot.shopId, month, knownAt: now }),
          this.adjustments.forShop(snapshot.shopId, { refersToMonth: month, primary: true }),
        ]);
        const residual = residualOf(
          fresh,
          {
            grossMinor: snapshot.grossMinor,
            commissionMinor: snapshot.commissionMinor,
            lineCount: snapshot.lineCount,
            payoutsPaidMinor: snapshot.payoutsPaidMinor,
          },
          earlier,
        );
        if (isZeroResidual(residual)) continue;
        const finding = completenessFinding(
          snapshot.shopId,
          {
            commission: fresh.commissionMinor,
            gross: fresh.grossMinor,
            payouts: fresh.payoutsPaidMinor,
            lines: fresh.lineCount,
          },
          residual,
        );
        if (finding) drafts.push(finding);
      }
      after = page[page.length - 1].shopId;
      if (page.length < SNAPSHOT_PAGE) break;
    }
    return drafts;
  }

  async findingsPage(
    month: string,
    query: { limit: number; cursor?: string },
  ): Promise<ReconciliationFindingPage> {
    if (!isMonthAvailable(month, this.clock.now())) throw monthNotAvailable();
    const secret = `${this.config.get('jwt_secret')}`;
    const before = query.cursor
      ? decodeCursor(query.cursor, 'findings', month, secret)
      : null;
    const rows = await this.findings.page(
      month,
      before ? { openedAt: before.k, id: before.id! } : null,
      query.limit + 1,
    );
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ r: 'findings', s: month, k: last.openedAt, id: last.id }, secret)
          : null,
    };
  }
}
