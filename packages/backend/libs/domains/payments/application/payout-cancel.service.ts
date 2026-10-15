import { Inject, Injectable } from '@nestjs/common';
import type { AdminPayoutView } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { PayoutNotFound, PayoutStateConflict } from '../domain/payout-errors';
import {
  PAYOUT_REPOSITORY,
  type PayoutRepository,
} from '../domain/payout-ports';
import { PayoutTransitionService } from './payout-transition.service';
import { toAdminPayoutView } from './payout-views';

/**
 * An operator stops a payout that has not started (S15 FR-039, AS-42…AS-44). Only `PENDING` can be cancelled: the same
 * conditional update that the transfer's claim uses, so exactly one of cancel and send wins. The reversal, the
 * history row (actor and reason) and `payout.cancelled` commit with the status.
 */
@Injectable()
export class PayoutCancelService {
  constructor(
    @Inject(PAYOUT_REPOSITORY) private readonly payouts: PayoutRepository,
    private readonly transitions: PayoutTransitionService,
    private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async cancel(
    payoutId: string,
    actor: string,
    reason: string,
  ): Promise<AdminPayoutView> {
    const result = await this.runner.run((tx) =>
      this.transitions.apply(
        payoutId,
        'cancel',
        {
          actor,
          reason,
          cancelledBy: actor,
          journal: 'reversal',
          event: 'cancelled',
          patch: { cancelledAt: this.clock.now() },
        },
        tx,
      ),
    );
    if (result.kind === 'not_found') throw new PayoutNotFound();
    if (result.kind === 'refused') throw new PayoutStateConflict(result.status);
    return toAdminPayoutView(result.payout);
  }
}
