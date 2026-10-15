import { Inject, Injectable } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  PAYOUT_EVENTS,
  PAYOUT_LEDGER,
  PAYOUT_REPOSITORY,
  type PayoutEventsPort,
  type PayoutLedgerPort,
  type PayoutPatch,
  type PayoutRecord,
  type PayoutRepository,
} from '../domain/payout-ports';
import {
  transition,
  type PayoutEvent,
  type PayoutStatus,
} from '../domain/payout-state';
import { payoutEvents } from './events/payout-events';
import type { PayoutDiscrepancyKind } from '@marketplace-sandbox/contracts';

/** What a transition does besides moving the status: the same transaction carries it all (S15 FR-025, FR-044). */
export interface TransitionEffects {
  actor: string;
  reason?: string | null;
  patch?: PayoutPatch;
  /** The ledger posting that follows the new state (FR-026). */
  journal?: 'sent' | 'reversal';
  /** The domain event that announces the new state. */
  event?: 'paid' | 'failed' | 'cancelled';
  /** `cancelled` only: the operator. */
  cancelledBy?: string;
}

export type TransitionResult =
  | { kind: 'applied'; payout: PayoutRecord; previous: PayoutStatus }
  /** The pair `(status, event)` is refused: another path moved the payout, or the event contradicts a final state. */
  | { kind: 'refused'; status: PayoutStatus }
  | { kind: 'not_found' };

/** The status an event would leave a payout in, when it already is there: a duplicate, not a conflict. */
const TARGET: Record<PayoutEvent, PayoutStatus> = {
  claim: 'SENDING',
  cancel: 'CANCELLED',
  provider_success: 'PAID',
  resolver_found_paid: 'PAID',
  provider_rejected: 'FAILED',
  resolver_found_rejected: 'FAILED',
  provider_unknown: 'UNKNOWN',
  retries_exhausted: 'UNKNOWN',
};

/** True when a final status says the opposite of the event (a late rejection after `PAID`, a late success after `FAILED`). */
export function contradicts(status: PayoutStatus, event: PayoutEvent): boolean {
  const target = TARGET[event];
  const final = (s: PayoutStatus) =>
    s === 'PAID' || s === 'FAILED' || s === 'CANCELLED';
  return final(status) && final(target) && status !== target;
}

/**
 * The only place a payout changes status (S15 FR-024, FR-025). One conditional update (`… WHERE id AND status`), the
 * history row, `payoutVersion + 1`, the ledger posting and the outbox event all happen in the caller's transaction, so a
 * rollback removes every trace. Never calls the provider.
 */
@Injectable()
export class PayoutTransitionService {
  constructor(
    @Inject(PAYOUT_REPOSITORY) private readonly payouts: PayoutRepository,
    @Inject(PAYOUT_LEDGER) private readonly ledger: PayoutLedgerPort,
    @Inject(PAYOUT_EVENTS) private readonly events: PayoutEventsPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async apply(
    payoutId: string,
    event: PayoutEvent,
    effects: TransitionEffects,
    tx: Transaction,
  ): Promise<TransitionResult> {
    const current = await this.payouts.findById(payoutId, tx);
    if (!current) return { kind: 'not_found' };
    const to = transition(current.status, event);
    if (to === null) return { kind: 'refused', status: current.status };

    const now = this.clock.now();
    const updated = await this.payouts.transition(
      payoutId,
      [current.status],
      to,
      effects.patch ?? {},
      now,
      tx,
    );
    if (!updated) {
      const latest = await this.payouts.findById(payoutId, tx);
      return latest
        ? { kind: 'refused', status: latest.status }
        : { kind: 'not_found' };
    }

    await this.payouts.appendHistory(
      {
        payoutId,
        fromStatus: current.status,
        toStatus: to,
        payoutVersion: updated.payoutVersion,
        actor: effects.actor,
        reason: effects.reason ?? null,
        at: now,
      },
      tx,
    );
    if (effects.journal === 'sent') await this.ledger.postSent(updated, tx);
    if (effects.journal === 'reversal')
      await this.ledger.postReversal(updated, tx);
    if (effects.event) await this.announce(effects.event, updated, effects, tx);
    return { kind: 'applied', payout: updated, previous: current.status };
  }

  /** Appends one lifecycle event to the outbox in `tx`. */
  private async announce(
    event: 'paid' | 'failed' | 'cancelled',
    p: PayoutRecord,
    effects: TransitionEffects,
    tx: Transaction,
  ): Promise<void> {
    const base = {
      payoutId: p.id,
      shopId: p.shopId,
      periodStart: p.periodStart,
      amountMinor: p.amountMinor,
      currency: p.currency,
      payoutVersion: p.payoutVersion,
    };
    const defs = payoutEvents();
    switch (event) {
      case 'paid':
        return this.events.append(
          defs.paid.create(p.id, p.payoutVersion, {
            ...base,
            transferRef: p.transferRef ?? '',
            paidAt: (p.paidAt ?? this.clock.now()).toISOString(),
          }),
          tx,
        );
      case 'failed':
        return this.events.append(
          defs.failed.create(p.id, p.payoutVersion, {
            ...base,
            failureCode: p.failureCode ?? 'provider_rejected',
          }),
          tx,
        );
      case 'cancelled':
        return this.events.append(
          defs.cancelled.create(p.id, p.payoutVersion, {
            ...base,
            cancelledBy: effects.cancelledBy ?? effects.actor,
            reason: effects.reason ?? '',
          }),
          tx,
        );
    }
  }

  /** `payout.created`: appended by the creation step (a payout comes into being, it does not transition). */
  appendCreated(p: PayoutRecord, tx: Transaction): Promise<void> {
    return this.events.append(
      payoutEvents().created.create(p.id, p.payoutVersion, {
        payoutId: p.id,
        shopId: p.shopId,
        periodStart: p.periodStart,
        amountMinor: p.amountMinor,
        reserveHeldMinor: p.reserveHeldMinor,
        currency: p.currency,
        payoutVersion: p.payoutVersion,
      }),
      tx,
    );
  }

  /** `payout.in_doubt`: only the call that set `inDoubtEventAt` appends it. */
  async reportInDoubt(p: PayoutRecord, tx: Transaction): Promise<boolean> {
    const now = this.clock.now();
    if (!(await this.payouts.markOnce(p.id, 'inDoubtEventAt', now, tx)))
      return false;
    await this.events.append(
      payoutEvents().inDoubt.create(p.id, p.payoutVersion, {
        payoutId: p.id,
        shopId: p.shopId,
        periodStart: p.periodStart,
        amountMinor: p.amountMinor,
        currency: p.currency,
        inDoubtSince: (p.inDoubtSince ?? now).toISOString(),
        payoutVersion: p.payoutVersion,
      }),
      tx,
    );
    return true;
  }

  /** `payout.discrepancy_detected` for one occurrence (the caller decides how often). */
  reportDiscrepancy(
    p: Pick<PayoutRecord, 'id' | 'shopId' | 'payoutVersion'>,
    kind: PayoutDiscrepancyKind,
    tx: Transaction,
  ): Promise<void> {
    return this.events.append(
      payoutEvents().discrepancy.create(p.id, p.payoutVersion, {
        payoutId: p.id,
        shopId: p.shopId,
        kind,
        payoutVersion: p.payoutVersion,
      }),
      tx,
    );
  }

  /** A conflicting late outcome is reported once per payout (`discrepancyReportedAt`). */
  async reportConflictOnce(p: PayoutRecord, tx: Transaction): Promise<boolean> {
    if (
      !(await this.payouts.markOnce(
        p.id,
        'discrepancyReportedAt',
        this.clock.now(),
        tx,
      ))
    )
      return false;
    await this.reportDiscrepancy(p, 'conflicting_outcome', tx);
    return true;
  }
}
