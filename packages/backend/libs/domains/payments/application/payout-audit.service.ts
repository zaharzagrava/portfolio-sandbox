import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PayoutDiscrepancyKind } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { payoutDiscrepancyCounter } from '../domain/payout-metrics';
import {
  PAYOUT_AUDIT_REPOSITORY,
  PAYOUT_PROVIDER,
  PAYOUT_REPOSITORY,
  type PayoutAuditRepository,
  type PayoutProviderPort,
  type PayoutRecord,
  type PayoutRepository,
} from '../domain/payout-ports';
import { validateProviderAnswer } from '../domain/provider-answer';
import { PayoutTransitionService } from './payout-transition.service';

const DAY_MS = 86_400_000;
const PAGE = 100;

export interface AuditSummary {
  day: string;
  status: 'COMPLETED' | 'FAILED';
  checked: number;
  discrepancies: number;
}

/** The previous UTC day as `YYYY-MM-DD`. */
export const previousUtcDay = (now: Date): string =>
  new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      DAY_MS,
  )
    .toISOString()
    .slice(0, 10);

/**
 * The daily proof against the provider (S15 FR-042, AS-49): every payout paid on a closed UTC day is looked up by
 * reference and compared with what we sent. A difference is a finding, inserted once per `(payout, kind)`; only the
 * insert that created it emits the metric and `payout.discrepancy_detected`, in the same transaction. The audit
 * changes no payout and posts nothing. If the provider cannot be reached the day is `FAILED` and nothing is written.
 */
@Injectable()
export class PayoutAuditService {
  private readonly logger = new Logger(PayoutAuditService.name);

  constructor(
    @Inject(PAYOUT_REPOSITORY) private readonly payouts: PayoutRepository,
    @Inject(PAYOUT_PROVIDER) private readonly provider: PayoutProviderPort,
    @Inject(PAYOUT_AUDIT_REPOSITORY)
    private readonly audits: PayoutAuditRepository,
    private readonly transitions: PayoutTransitionService,
    private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async auditDay(input?: string): Promise<AuditSummary> {
    const now = this.clock.now();
    const day = input ?? previousUtcDay(now);
    const from = new Date(`${day}T00:00:00.000Z`);
    if (
      Number.isNaN(from.getTime()) ||
      from.toISOString().slice(0, 10) !== day ||
      from.getTime() + DAY_MS > now.getTime()
    )
      throw new RangeError('the audit day must be a closed UTC day');
    const to = new Date(from.getTime() + DAY_MS);

    await this.audits.startDay(day, now);
    const findings: { payout: PayoutRecord; kind: PayoutDiscrepancyKind }[] =
      [];
    let checked = 0;
    try {
      let after: string | null = null;
      for (;;) {
        const page = await this.payouts.paidBetween(from, to, after, PAGE);
        if (page.length === 0) break;
        for (const payout of page) {
          checked += 1;
          const kind = await this.classify(payout);
          if (kind) findings.push({ payout, kind });
        }
        after = page[page.length - 1].id;
      }
    } catch (error) {
      await this.audits.finishDay(
        day,
        { status: 'FAILED', checked: 0, discrepancies: 0 },
        this.clock.now(),
      );
      this.logger.error(
        `payout audit of ${day} failed: ${(error as Error).name}`,
      );
      return { day, status: 'FAILED', checked: 0, discrepancies: 0 };
    }

    let discrepancies = 0;
    for (const { payout, kind } of findings) {
      const created = await this.runner.run(async (tx) => {
        const inserted = await this.audits.insertFinding(
          payout.id,
          kind,
          day,
          this.clock.now(),
          tx,
        );
        if (inserted)
          await this.transitions.reportDiscrepancy(payout, kind, tx);
        return inserted;
      });
      if (created) {
        discrepancies += 1;
        payoutDiscrepancyCounter.add(1, { kind });
      }
    }
    await this.audits.finishDay(
      day,
      { status: 'COMPLETED', checked, discrepancies },
      this.clock.now(),
    );
    return { day, status: 'COMPLETED', checked, discrepancies };
  }

  /** The first difference between a paid payout and the provider's record of it, or `null`. Throws when unreachable. */
  private async classify(
    payout: PayoutRecord,
  ): Promise<PayoutDiscrepancyKind | null> {
    const found = await this.provider.lookupByReference(payout.id);
    if (found.kind === 'unreachable')
      throw new Error('provider unreachable during the audit');
    if (found.kind !== 'found') return 'missing_transfer';
    const checked = validateProviderAnswer(
      {
        amountMinor: payout.amountMinor,
        currency: payout.currency,
        destination: payout.destinationSnapshot ?? '',
      },
      found.answer,
    );
    if (!checked.ok) return checked.kind;
    return found.reversed ? 'reversed_at_provider' : null;
  }
}
