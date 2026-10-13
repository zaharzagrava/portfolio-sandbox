import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { Fatal_BadRequestError } from '@app/common/errors';
import { TransactionRunner } from '@app/infrastructure/context';
import type { ReconciliationIssue } from '@marketplace-sandbox/contracts';
import { parseAccountId } from '../domain/account';
import {
  AdjustmentInvalid,
  IssueAlreadyResolved,
  ReconciliationIssueNotFound,
} from '../domain/ledger-errors';
import {
  RECONCILIATION_STORE,
  type ReconciliationStore,
} from '../domain/ledger-ports';
import { resolveIssue } from '../domain/issue-state';
import { JournalPostingService } from './journal-posting.service';
import { ReconciliationGauges } from './reconciliation-gauges.service';

export interface ResolveInput {
  resolution: 'explained' | 'adjusted';
  note: string;
  adjustment?: {
    currency: string;
    lines: { accountId: string; amountMinor: number }[];
  };
}

const MAX_ADJUSTMENT_LINES = 10;

/**
 * An operator closes an issue (S14 FR-039…FR-041): `explained` just records who and why; `adjusted` also posts one
 * balanced `ADJUSTMENT` journal, never backdated, that records the closed day it corrects. The issue change, the
 * journal, the history row and the journal's event are ONE transaction. Competing resolutions have one winner: the
 * conditional update; the loser is rolled back before it posts (so at most one journal exists). Checks run in the
 * order of contracts/http.md, so a bad request never reaches the books.
 */
@Injectable()
export class IssueResolutionService {
  constructor(
    @Inject(RECONCILIATION_STORE) private readonly store: ReconciliationStore,
    private readonly posting: JournalPostingService,
    private readonly transactions: TransactionRunner,
    private readonly gauges: ReconciliationGauges,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async resolve(
    issueId: string,
    actor: string,
    input: ResolveInput,
  ): Promise<ReconciliationIssue> {
    if (input.resolution === 'adjusted' && !input.adjustment)
      throw new Fatal_BadRequestError({
        detail: 'an adjusted resolution needs an adjustment',
      });
    if (input.resolution === 'explained' && input.adjustment)
      throw new Fatal_BadRequestError({
        detail: 'an explained resolution takes no adjustment',
      });

    const issue = await this.store.findIssue(issueId);
    if (!issue) throw new ReconciliationIssueNotFound();
    resolveIssueState(issue.status, input.resolution); // 409 for a resolved issue
    if (input.adjustment) this.checkAdjustment(input.adjustment);

    const resolved = await this.transactions.run(async (tx) => {
      const now = this.clock.now();
      const updated = await this.store.resolveOpenIssue(
        {
          id: issueId,
          resolution: input.resolution,
          note: input.note,
          actor,
          now,
        },
        tx,
      );
      if (!updated) {
        // lost the race (or the issue vanished): nothing was written, the whole transaction ends here
        if (!(await this.store.findIssue(issueId, tx)))
          throw new ReconciliationIssueNotFound();
        throw new IssueAlreadyResolved();
      }
      let result = updated;
      if (input.resolution === 'adjusted' && input.adjustment) {
        const posted = await this.posting.post(
          {
            kind: 'ADJUSTMENT',
            reference: `issue:${issueId}`,
            currency: input.adjustment.currency,
            fromCaller: true,
            lines: input.adjustment.lines,
            links: { correctsDay: issue.day },
          },
          tx,
        );
        await this.store.linkAdjustment(issueId, posted.journalId, tx);
        result = { ...updated, adjustmentJournalId: posted.journalId };
      }
      await this.store.addHistory(
        {
          issueId,
          at: now,
          actor,
          resolution: input.resolution,
          note: input.note,
        },
        tx,
      );
      return result;
    });
    await this.gauges.refresh();
    return resolved;
  }

  private checkAdjustment(
    adjustment: NonNullable<ResolveInput['adjustment']>,
  ): void {
    if (adjustment.lines.length > MAX_ADJUSTMENT_LINES)
      throw new AdjustmentInvalid('adjustment_too_large');
    if (adjustment.lines.some((l) => !parseAccountId(l.accountId)))
      throw new AdjustmentInvalid('adjustment_account_invalid');
    const sum = adjustment.lines.reduce(
      (s, l) => s + BigInt(l.amountMinor),
      0n,
    );
    if (adjustment.lines.length < 2 || sum !== 0n)
      throw new AdjustmentInvalid('adjustment_unbalanced');
  }
}

/** The pure state rule, raising the problem the API answers (`409`). */
function resolveIssueState(
  status: 'OPEN' | 'RESOLVED',
  resolution: 'explained' | 'adjusted',
): void {
  try {
    resolveIssue(status, resolution);
  } catch {
    throw new IssueAlreadyResolved();
  }
}
