import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { resolverDelayMs } from '../domain/payout-backoff';
import {
  payoutInDoubtAgeGauge,
  payoutProviderMismatchCounter,
} from '../domain/payout-metrics';
import {
  PAYOUT_PROVIDER,
  PAYOUT_REPOSITORY,
  type PayoutProviderPort,
  type PayoutRecord,
  type PayoutRepository,
} from '../domain/payout-ports';
import { validateProviderAnswer } from '../domain/provider-answer';
import { RANDOM } from '../domain/ports';
import { PayoutTransferService } from './payout-transfer.service';
import { PayoutTransitionService } from './payout-transition.service';

const HOUR_MS = 3_600_000;
const EXHAUSTED_WAIT_MS = 15 * 60_000;

export interface ResolveSummary {
  settled: number;
  resent: number;
  unreachable: number;
}

/**
 * Settles payouts whose provider outcome is not known (S15 FR-018, FR-022, research R-5): a payout `UNKNOWN`, or
 * `SENDING` for longer than the stale threshold. The transfer is looked up by reference (never guessed): found →
 * `PAID`; rejected → `FAILED`; unknown to the provider → the same-key re-send, at most a configured number of times;
 * provider unreachable → nothing changes and the next look is later (full jitter), never `FAILED`. After the
 * in-doubt period one `payout.in_doubt` event is raised and the code stops: a human decides.
 */
@Injectable()
export class PayoutResolverService {
  private readonly logger = new Logger(PayoutResolverService.name);

  constructor(
    @Inject(PAYOUT_REPOSITORY) private readonly payouts: PayoutRepository,
    @Inject(PAYOUT_PROVIDER) private readonly provider: PayoutProviderPort,
    private readonly transfers: PayoutTransferService,
    private readonly transitions: PayoutTransitionService,
    private readonly runner: TransactionRunner,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RANDOM) private readonly random: () => number,
  ) {}

  async resolveDue(limit: number): Promise<ResolveSummary> {
    const now = this.clock.now();
    const due = await this.payouts.dueForResolution(
      now,
      new Date(now.getTime() - this.config.get('payout_stale_sending_ms')),
      limit,
    );
    const summary: ResolveSummary = { settled: 0, resent: 0, unreachable: 0 };
    for (const payout of due) {
      try {
        await this.resolveOne(payout, summary);
      } catch (error) {
        // One payout's trouble never blocks the others; it is looked at again on the next run.
        this.logger.error(
          `payout ${payout.id} could not be resolved: ${(error as Error).name}`,
        );
      }
    }
    await this.refreshGauge();
    return summary;
  }

  private async resolveOne(
    first: PayoutRecord,
    summary: ResolveSummary,
  ): Promise<void> {
    const now = this.clock.now();
    let payout = first;
    if (!payout.inDoubtSince) {
      await this.payouts.updateWhileInDoubt(
        payout.id,
        { inDoubtSince: now },
        now,
      );
      payout = { ...payout, inDoubtSince: now };
    }
    await this.reportIfLong(payout, now);

    const found = await this.provider.lookupByReference(payout.id);
    switch (found.kind) {
      case 'found': {
        const checked = validateProviderAnswer(
          {
            amountMinor: payout.amountMinor,
            currency: payout.currency,
            destination: payout.destinationSnapshot ?? '',
          },
          found.answer,
        );
        if (!checked.ok) {
          // A transfer that is not the one we asked for is never accepted as ours.
          payoutProviderMismatchCounter.add(1, { kind: checked.kind });
          await this.transfers.settle(
            payout,
            'provider_unknown',
            this.transfers.unknownEffects(payout),
            checked.kind,
          );
          await this.later(payout, now, EXHAUSTED_WAIT_MS);
          return;
        }
        const result = await this.transfers.settle(
          payout,
          'resolver_found_paid',
          this.transfers.paidEffects(checked.transferRef),
        );
        if (result.kind === 'settled') summary.settled += 1;
        return;
      }
      case 'found_rejected': {
        const result = await this.transfers.reject(
          payout,
          found.code,
          'resolver_found_rejected',
        );
        if (result.kind === 'settled') summary.settled += 1;
        return;
      }
      case 'not_found': {
        if (
          payout.resendCount >= this.config.get('payout_resolver_max_resends')
        ) {
          await this.later(payout, now, EXHAUSTED_WAIT_MS);
          return;
        }
        await this.payouts.updateWhileInDoubt(
          payout.id,
          { resendCount: payout.resendCount + 1 },
          now,
        );
        summary.resent += 1;
        const result = await this.transfers.callProvider(
          { ...payout, resendCount: payout.resendCount + 1 },
          'resolver',
        );
        if (result.kind === 'settled') summary.settled += 1;
        else await this.later(payout, now, EXHAUSTED_WAIT_MS / 3);
        return;
      }
      case 'unreachable': {
        summary.unreachable += 1;
        const delay = resolverDelayMs(payout.lookupFailures, this.random);
        await this.payouts.updateWhileInDoubt(
          payout.id,
          {
            lookupFailures: payout.lookupFailures + 1,
            nextResolveAt: new Date(now.getTime() + delay),
          },
          now,
        );
        return;
      }
    }
  }

  private later(
    payout: PayoutRecord,
    now: Date,
    waitMs: number,
  ): Promise<void> {
    return this.payouts.updateWhileInDoubt(
      payout.id,
      { nextResolveAt: new Date(now.getTime() + waitMs) },
      now,
    );
  }

  /** One `payout.in_doubt` per payout, once it has been in doubt for the configured period. */
  private async reportIfLong(payout: PayoutRecord, now: Date): Promise<void> {
    if (!payout.inDoubtSince || payout.inDoubtEventAt) return;
    const limit = this.config.get('payout_in_doubt_after_hours') * HOUR_MS;
    if (now.getTime() - payout.inDoubtSince.getTime() < limit) return;
    await this.runner.run(async (tx) => {
      const current = await this.payouts.findById(payout.id, tx);
      if (current) await this.transitions.reportInDoubt(current, tx);
    });
  }

  /** Age in seconds of the oldest payout still in doubt; 0 when none. */
  async refreshGauge(): Promise<void> {
    const oldest = await this.payouts.oldestInDoubtSince();
    payoutInDoubtAgeGauge.set(
      oldest
        ? Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000)
        : 0,
    );
  }
}
