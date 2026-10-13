import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  reconciliationIssuesOpenGauge,
  reconciliationOldestOpenIssueGauge,
} from '../domain/ledger-metrics';
import { ISSUE_KINDS } from '../domain/reconciliation-matcher';
import {
  RECONCILIATION_STORE,
  type ReconciliationStore,
} from '../domain/ledger-ports';

/** The gauges finance alerts on: open issues by kind and the age of the oldest (AS-39, AS-49, AS-53, AS-65). */
@Injectable()
export class ReconciliationGauges {
  constructor(
    @Inject(RECONCILIATION_STORE) private readonly store: ReconciliationStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async refresh(): Promise<void> {
    const stats = await this.store.openIssueStats(this.clock.now());
    for (const kind of ISSUE_KINDS)
      reconciliationIssuesOpenGauge.set(stats.byKind[kind] ?? 0, { kind });
    reconciliationOldestOpenIssueGauge.set(stats.oldestAgeSeconds);
  }
}
