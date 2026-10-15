import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PayoutDiscrepancyKind } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { TransientPayoutError } from '../domain/payout-errors';
import {
  payoutConflictingOutcomeCounter,
  payoutProviderMismatchCounter,
  payoutTransferCounter,
} from '../domain/payout-metrics';
import {
  PAYOUT_PROVIDER,
  PAYOUT_REPOSITORY,
  type PayoutPatch,
  type PayoutProviderPort,
  type PayoutRecord,
  type PayoutRepository,
  type TransferOutcome,
} from '../domain/payout-ports';
import type { PayoutEvent } from '../domain/payout-state';
import { validateProviderAnswer } from '../domain/provider-answer';
import {
  contradicts,
  PayoutTransitionService,
  type TransitionEffects,
} from './payout-transition.service';

/** Provider codes that mean the destination itself is wrong; every other definite rejection is the provider's. */
const DESTINATION_CODES = new Set([
  'account_closed',
  'account_invalid',
  'invalid_destination',
  'destination_missing',
]);

const safeCode = (code: string): string =>
  code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) || 'unspecified';

export type SendContext = { attempt: number; isLastAttempt: boolean };

/** How a provider call ended, after the answer was checked. */
export type CallResult =
  | { kind: 'settled'; event: PayoutEvent }
  | { kind: 'unchanged'; reason: 'transient' | 'unknown' | 'refused' };

/**
 * Sends one payout to the provider exactly once (S15 FR-013…FR-021, research R-3). Claim (a committed conditional
 * update, fenced by the job attempt) → the provider call with NO transaction open → the result transaction. The
 * provider's answer is validated before it is believed; an unanswered or unreadable request is `UNKNOWN`, never
 * `FAILED`, and is settled later by looking the transfer up by reference (the resolver), not by sending blindly.
 */
@Injectable()
export class PayoutTransferService {
  private readonly logger = new Logger(PayoutTransferService.name);

  constructor(
    @Inject(PAYOUT_REPOSITORY) private readonly payouts: PayoutRepository,
    @Inject(PAYOUT_PROVIDER) private readonly provider: PayoutProviderPort,
    private readonly transitions: PayoutTransitionService,
    private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async send(payoutId: string, ctx: SendContext): Promise<void> {
    const payout = await this.payouts.findById(payoutId);
    if (!payout) return;
    if (!(await this.claim(payout, ctx.attempt))) return;
    const claimed = await this.payouts.findById(payoutId);
    if (!claimed) return;

    const result = await this.callProvider(claimed, 'job', ctx.isLastAttempt);
    if (result.kind === 'unchanged' && result.reason === 'transient')
      throw new TransientPayoutError('provider');
  }

  /**
   * `PENDING → SENDING` for the first delivery; a redelivery of a `SENDING` payout takes the attempt only when its job
   * attempt is newer than the one that holds it. Anything else (another delivery of the same attempt, a final or
   * unknown payout) finishes without calling the provider.
   */
  private async claim(payout: PayoutRecord, attempt: number): Promise<boolean> {
    if (payout.status === 'PENDING') {
      const claim = await this.runner.run((tx) =>
        this.transitions.apply(
          payout.id,
          'claim',
          {
            actor: 'system',
            patch: { attempts: attempt, submittedAt: this.clock.now() },
          },
          tx,
        ),
      );
      if (claim.kind === 'applied') return true;
      if (claim.kind === 'not_found' || claim.status !== 'SENDING')
        return false;
    } else if (payout.status !== 'SENDING') return false;
    return this.runner.run((tx) =>
      this.payouts.takeAttempt(payout.id, attempt, tx),
    );
  }

  /**
   * The provider call and its settlement for a payout that is `SENDING` (job) or `SENDING`/`UNKNOWN` (resolver
   * re-send). `lastAttempt` turns a transient answer into `UNKNOWN`; the resolver passes `'resolver'` and keeps an
   * `UNKNOWN` payout `UNKNOWN`.
   */
  async callProvider(
    payout: PayoutRecord,
    caller: 'job' | 'resolver',
    isLastAttempt = false,
  ): Promise<CallResult> {
    const destination = payout.destinationSnapshot;
    if (!destination) return this.reject(payout, 'destination_missing');

    let outcome: TransferOutcome;
    try {
      // No transaction is open here (AS-29): the call may take as long as the timeout.
      outcome = await this.provider.transfer({
        payoutId: payout.id,
        amountMinor: payout.amountMinor,
        currency: payout.currency,
        destination,
      });
    } catch {
      outcome = { kind: 'unknown' };
    }

    switch (outcome.kind) {
      case 'answered': {
        const checked = validateProviderAnswer(
          {
            amountMinor: payout.amountMinor,
            currency: payout.currency,
            destination,
          },
          outcome.answer,
        );
        if (checked.ok) {
          payoutTransferCounter.add(1, { outcome: 'paid' });
          return this.settle(
            payout,
            'provider_success',
            this.paidEffects(checked.transferRef),
          );
        }
        payoutProviderMismatchCounter.add(1, { kind: checked.kind });
        payoutTransferCounter.add(1, { outcome: 'unknown' });
        return this.settle(
          payout,
          'provider_unknown',
          this.unknownEffects(payout),
          checked.kind,
        );
      }
      case 'rejected':
        return this.reject(payout, outcome.code);
      case 'transient':
        payoutTransferCounter.add(1, { outcome: 'transient' });
        if (caller === 'job' && isLastAttempt)
          return this.settle(
            payout,
            'retries_exhausted',
            this.unknownEffects(payout),
          );
        return { kind: 'unchanged', reason: 'transient' };
      case 'unknown':
        payoutTransferCounter.add(1, { outcome: 'unknown' });
        return this.settle(
          payout,
          'provider_unknown',
          this.unknownEffects(payout),
        );
    }
  }

  /** A definite rejection: `FAILED`, the reservation returned to the shop, no retry. */
  async reject(
    payout: PayoutRecord,
    code: string,
    event: PayoutEvent = 'provider_rejected',
  ): Promise<CallResult> {
    payoutTransferCounter.add(1, { outcome: 'rejected' });
    return this.settle(payout, event, {
      actor: 'system',
      journal: 'reversal',
      event: 'failed',
      patch: {
        failureCode: DESTINATION_CODES.has(code)
          ? 'destination_rejected'
          : 'provider_rejected',
        failureReason: `provider rejected the transfer: ${safeCode(code)}`,
        nextResolveAt: null,
      },
    });
  }

  paidEffects(transferRef: string): TransitionEffects {
    return {
      actor: 'system',
      journal: 'sent',
      event: 'paid',
      patch: { transferRef, paidAt: this.clock.now(), nextResolveAt: null },
    };
  }

  /** Moves a payout to `UNKNOWN` and marks when the doubt began (kept if it already had). */
  unknownEffects(payout: PayoutRecord): TransitionEffects {
    const now = this.clock.now();
    const patch: PayoutPatch = {
      inDoubtSince: payout.inDoubtSince ?? now,
      nextResolveAt: now,
    };
    return { actor: 'system', patch };
  }

  /**
   * The result transaction: the transition with its journal and event, plus the discrepancy event of a mismatch. A
   * late outcome that contradicts a final payout changes nothing and is reported once (AS-28).
   */
  async settle(
    payout: PayoutRecord,
    event: PayoutEvent,
    effects: TransitionEffects,
    mismatch?: PayoutDiscrepancyKind,
  ): Promise<CallResult> {
    const outcome = await this.runner.run(async (tx) => {
      const result = await this.transitions.apply(
        payout.id,
        event,
        effects,
        tx,
      );
      if (result.kind === 'applied' && mismatch)
        await this.transitions.reportDiscrepancy(result.payout, mismatch, tx);
      if (result.kind === 'refused' && contradicts(result.status, event)) {
        const latest = await this.payouts.findById(payout.id, tx);
        if (latest) await this.transitions.reportConflictOnce(latest, tx);
      }
      return result;
    });
    if (outcome.kind === 'applied') return { kind: 'settled', event };
    if (outcome.kind === 'refused' && contradicts(outcome.status, event)) {
      payoutConflictingOutcomeCounter.add(1);
      this.logger.warn(
        JSON.stringify({
          event: 'payout.conflicting_outcome',
          payoutId: payout.id,
          status: outcome.status,
          late: event,
        }),
      );
    }
    return { kind: 'unchanged', reason: 'refused' };
  }
}
