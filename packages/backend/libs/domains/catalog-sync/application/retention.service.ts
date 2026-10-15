import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CONFLICT_REPOSITORY,
  INSTALL_REPOSITORY,
  QUARANTINE_REPOSITORY,
  RECEIPT_REPOSITORY,
  RECONCILIATION_REPOSITORY,
  RUN_REPOSITORY,
  SYNC_CLOCK,
  type Clock,
  type ConflictRepository,
  type InstallRepository,
  type QuarantineRepository,
  type ReceiptRepository,
  type ReconciliationRepository,
  type RunRepository,
} from '../domain/ports';

const DAY = 86_400_000;

/** Retention windows of FR-081 / AS-76. */
export const RETENTION = {
  receiptsMs: 7 * DAY,
  runsMs: 30 * DAY,
  closedItemsMs: 30 * DAY,
  installsMs: 1 * DAY,
  reportsMs: 90 * DAY,
  openItemsMs: 90 * DAY,
  /** Rows deleted or closed per kind in one run, oldest first. */
  perKindPerRun: 5_000,
} as const;

export interface RetentionResult {
  receipts: number;
  runs: number;
  /** Closed (`RESOLVED`/`DISMISSED`) quarantine rows deleted. */
  quarantine: number;
  /** Dismissed conflicts deleted. */
  conflicts: number;
  installs: number;
  reports: number;
  /** Open quarantine rows and conflicts older than 90 days that were closed as `expired`. */
  expired: number;
}

/**
 * The scheduled `catalog-sync.purge-integration-data` (AS-76). Each kind has its own age rule and its own cap per run;
 * open items are closed, never deleted unseen, and are removed by a later run once their closed state is old enough.
 * A second run straight after finds nothing because every rule is a strict age cut-off.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(RECEIPT_REPOSITORY) private readonly receipts: ReceiptRepository,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(QUARANTINE_REPOSITORY)
    private readonly quarantine: QuarantineRepository,
    @Inject(CONFLICT_REPOSITORY) private readonly conflicts: ConflictRepository,
    @Inject(INSTALL_REPOSITORY) private readonly installs: InstallRepository,
    @Inject(RECONCILIATION_REPOSITORY)
    private readonly reports: ReconciliationRepository,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
  ) {}

  async run(): Promise<RetentionResult> {
    const now = this.clock.now();
    const before = (ms: number) => new Date(now.getTime() - ms);
    const limit = RETENTION.perKindPerRun;

    // Open items past 90 days are closed first; their closed state is then 0 days old, so they stay a while.
    const expiredQuarantine = await this.quarantine.expireOpenBefore(
      before(RETENTION.openItemsMs),
      now,
      limit,
    );
    const expiredConflicts = await this.conflicts.expireOpenBefore(
      before(RETENTION.openItemsMs),
      now,
      limit,
    );
    const result: RetentionResult = {
      receipts: await this.receipts.purgeReceivedBefore(
        before(RETENTION.receiptsMs),
        limit,
      ),
      runs: await this.runs.purgeStartedBefore(before(RETENTION.runsMs), limit),
      quarantine: await this.quarantine.purgeClosedBefore(
        before(RETENTION.closedItemsMs),
        limit,
      ),
      conflicts: await this.conflicts.purgeDismissedBefore(
        before(RETENTION.closedItemsMs),
        limit,
      ),
      installs: await this.installs.purgeExpiredBefore(
        before(RETENTION.installsMs),
        limit,
      ),
      reports: await this.reports.purgeStartedBefore(
        before(RETENTION.reportsMs),
        limit,
      ),
      expired: expiredQuarantine + expiredConflicts,
    };
    this.logger.log({ action: 'catalog-sync.retention', ...result });
    return result;
  }
}
