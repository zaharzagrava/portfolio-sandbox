import { Inject, Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  PAYOUT_JOBS,
  PAYOUT_LEDGER,
  PAYOUT_REPOSITORY,
  PayoutLedgerRefusal,
  type PayoutJobsPort,
  type PayoutLedgerPort,
  type PayoutRepository,
} from '../domain/payout-ports';
import type { SkipReason } from '../domain/eligibility';
import { planPayout } from '../domain/reserve';
import { PayoutTransitionService } from './payout-transition.service';

export const PAYOUT_CURRENCY = 'EUR';

export type CreationResult = 'created' | 'existing' | { skipped: SkipReason };

/**
 * The atomic creation step of one shop's payout (S15 FR-004, research R-2): the authoritative balance, the reserve /
 * minimum / cap rules, the payout row, the `PAYOUT` journal, the history row, `payout.created` and the send job are
 * ONE transaction, so a failure anywhere leaves none of them. No network call is made in here. A refusal by the ledger
 * (a charge that arrived after the balance was read, a busy account) rolls the step back and skips only this shop.
 */
@Injectable()
export class PayoutCreationService {
  constructor(
    @Inject(PAYOUT_REPOSITORY) private readonly payouts: PayoutRepository,
    @Inject(PAYOUT_LEDGER) private readonly ledger: PayoutLedgerPort,
    @Inject(PAYOUT_JOBS) private readonly jobs: PayoutJobsPort,
    private readonly transitions: PayoutTransitionService,
    private readonly runner: TransactionRunner,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async createFor(
    shopId: string,
    periodStart: string,
    input: { reserveBps: number; destination: string },
  ): Promise<CreationResult> {
    try {
      return await this.runner.run(async (tx) => {
        const balances = await this.ledger.balances(
          [shopId],
          PAYOUT_CURRENCY,
          tx,
        );
        const plan = planPayout(balances.get(shopId) ?? 0, input.reserveBps, {
          minMinor: this.config.get('payout_min_minor'),
          capMinor: this.config.get('payout_cap_minor'),
        });
        if (plan.kind === 'skip') return { skipped: plan.reason };

        const now = this.clock.now();
        const id = await this.payouts.insertIfAbsent(
          {
            shopId,
            periodStart,
            currency: PAYOUT_CURRENCY,
            amountMinor: plan.amountMinor,
            reserveHeldMinor: plan.reserveHeldMinor,
            destinationSnapshot: input.destination,
          },
          now,
          tx,
        );
        if (id === null) return 'existing' as const;

        await this.ledger.postCreated(
          {
            id,
            shopId,
            amountMinor: plan.amountMinor,
            currency: PAYOUT_CURRENCY,
          },
          tx,
        );
        await this.payouts.appendHistory(
          {
            payoutId: id,
            fromStatus: null,
            toStatus: 'PENDING',
            payoutVersion: 1,
            actor: 'system',
            reason: null,
            at: now,
          },
          tx,
        );
        const created = await this.payouts.findById(id, tx);
        await this.transitions.appendCreated(created!, tx);
        await this.jobs.enqueueSend(id, shopId, tx);
        return 'created' as const;
      });
    } catch (error) {
      if (error instanceof PayoutLedgerRefusal)
        return { skipped: error.reason };
      throw error;
    }
  }
}
