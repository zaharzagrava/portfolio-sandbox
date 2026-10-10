import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { afterCommit, TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  LEDGER_POSTING,
  ORDER_COPY_REPOSITORY,
  PAYMENT_HISTORY_REPOSITORY,
  PAYMENT_REPOSITORY,
  REALTIME_PORT,
  type LedgerPosting,
  type OrderCopyRepository,
  type PaymentHistoryRepository,
  type PaymentPatch,
  type PaymentRecord,
  type PaymentRepository,
  type RealtimePort,
} from '../domain/ports';
import {
  decide,
  InvalidPaymentTransition,
  type PaymentCommand,
  type PaymentStatus,
} from '../domain/payment-status';
import {
  completedForUnpayableOrderCounter,
  conflictingProviderStateCounter,
  paymentTransitionsCounter,
  unknownOutcomesCounter,
} from '../domain/payment-metrics';
import { paymentEvents } from './events/payment-events';

import './payment.job-types';

/** Facts the caller learned from the provider that the move stores with the status. */
export interface TransitionData {
  providerRef?: string;
  clientSecret?: string;
}

export type TransitionResult =
  | { kind: 'applied'; payment: PaymentRecord; previous: PaymentStatus }
  /** The payment already is where the command would take it (a competing path won): nothing to do, no error. */
  | { kind: 'already_applied'; payment: PaymentRecord }
  /** The provider (or another path) says something that contradicts a final status: reported, never applied. */
  | { kind: 'conflict'; payment: PaymentRecord }
  | { kind: 'invalid'; payment: PaymentRecord }
  | { kind: 'not_found' };

const MAX_RACE_ATTEMPTS = 3;

/** Where a command would take a payment that is already there, so a repeat or a loser of a race is a no-op. */
function alreadyThere(
  status: PaymentStatus,
  command: PaymentCommand,
): 'already' | 'conflict' | 'no' {
  switch (command.type) {
    case 'succeed':
      if (['COMPLETED', 'REFUND_PENDING', 'REFUNDED'].includes(status))
        return 'already';
      return status === 'FAILED' || status === 'CANCELLED' ? 'conflict' : 'no';
    case 'fail':
      if (status === 'FAILED' || status === 'CANCELLED') return 'already';
      return ['COMPLETED', 'REFUND_PENDING', 'REFUNDED'].includes(status)
        ? 'conflict'
        : 'no';
    case 'cancel':
      return status === 'CANCELLED' || status === 'FAILED' ? 'already' : 'no';
    case 'markUnknown':
      return status === 'UNKNOWN' ? 'already' : 'no';
    case 'requestRefund':
      return status === 'REFUND_PENDING' || status === 'REFUNDED'
        ? 'already'
        : 'no';
    case 'refundSucceeded':
      return status === 'REFUNDED' ? 'already' : 'no';
    case 'awaitCustomer':
      return 'no';
  }
}

/**
 * The only writer of payment state (S13 FR-021..FR-024). A move is a conditional update (`… WHERE id AND status AND
 * version`), so competing paths (charge, resolver, status refresh, order events, refund) cannot both apply it: the
 * loser re-reads and gets the winner's state, not an exception. History row, ledger posting, outbox event and the
 * resolution job commit in one transaction; the realtime push follows the commit. No network I/O in here.
 */
@Injectable()
export class PaymentTransitionService {
  private readonly logger = new Logger(PaymentTransitionService.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(PAYMENT_HISTORY_REPOSITORY)
    private readonly history: PaymentHistoryRepository,
    @Inject(ORDER_COPY_REPOSITORY)
    private readonly orderCopies: OrderCopyRepository,
    @Inject(LEDGER_POSTING) private readonly ledger: LedgerPosting,
    @Inject(REALTIME_PORT) private readonly realtime: RealtimePort,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Runs inside the caller's transaction when there is one. */
  async apply(
    paymentId: string,
    command: PaymentCommand,
    actor: string,
    data: TransitionData = {},
  ): Promise<TransitionResult> {
    const result = await this.runner.run(() =>
      this.applyInTransaction(paymentId, command, actor, data),
    );
    if (result.kind === 'conflict') {
      conflictingProviderStateCounter.add();
      this.logger.error(
        `payment ${paymentId} is ${result.payment.status} but ${command.type} was reported (order ${result.payment.orderId})`,
      );
    }
    return result;
  }

  private async applyInTransaction(
    paymentId: string,
    command: PaymentCommand,
    actor: string,
    data: TransitionData,
  ): Promise<TransitionResult> {
    for (let attempt = 0; attempt < MAX_RACE_ATTEMPTS; attempt++) {
      const current = await this.payments.findById(paymentId);
      if (!current) return { kind: 'not_found' };

      let decision;
      try {
        decision = decide(current.status, command, {
          attempted: current.chargeAttemptedAt !== null,
          requiresAction: current.requiresAction,
        });
      } catch (error) {
        if (!(error instanceof InvalidPaymentTransition)) throw error;
        const there = alreadyThere(current.status, command);
        if (there === 'already')
          return { kind: 'already_applied', payment: current };
        if (there === 'conflict') return { kind: 'conflict', payment: current };
        return { kind: 'invalid', payment: current };
      }

      const now = this.clock.now();
      const patch = this.patchFor(command, current, decision.to, data, now);
      const updated = await this.payments.move({
        id: current.id,
        from: current.status,
        version: current.version,
        to: decision.to,
        versionStep: decision.versionStep,
        patch,
        requireUnattempted: command.type === 'cancel',
        now,
      });
      if (!updated) continue; // lost the race: decide again against the new state

      if (decision.versionStep === 1)
        await this.history.insert({
          paymentId: current.id,
          version: updated.version,
          fromStatus: current.status,
          toStatus: decision.to,
          reason: this.reasonFor(command),
          actor,
          at: now,
        });
      await this.propagate(updated, now);
      paymentTransitionsCounter.add(1, {
        from: current.status,
        to: decision.to,
      });
      afterCommit(() => this.realtime.pushPaymentStatus(updated));
      return { kind: 'applied', payment: updated, previous: current.status };
    }
    const latest = await this.payments.findById(paymentId);
    return latest
      ? { kind: 'invalid', payment: latest }
      : { kind: 'not_found' };
  }

  private patchFor(
    command: PaymentCommand,
    current: PaymentRecord,
    to: PaymentStatus,
    data: TransitionData,
    now: Date,
  ): PaymentPatch {
    const patch: PaymentPatch = {};
    if (data.providerRef !== undefined) patch.providerRef = data.providerRef;
    switch (command.type) {
      case 'fail':
        patch.failureCode = command.code;
        break;
      case 'cancel':
        patch.failureCode = command.reason;
        break;
      case 'markUnknown':
        patch.unknownSince = now;
        patch.resolveChecks = 0;
        patch.nextResolveAt = new Date(
          now.getTime() + this.config.get('payments_resolve_first_delay_ms'),
        );
        break;
      case 'awaitCustomer':
        patch.requiresAction = true;
        if (data.clientSecret !== undefined)
          patch.clientSecret = data.clientSecret;
        break;
      case 'requestRefund':
        patch.refundRequestedAt = current.refundRequestedAt ?? now;
        patch.refundNextAt = now;
        break;
      default:
        break;
    }
    if (current.status === 'UNKNOWN' && to !== 'UNKNOWN') {
      patch.nextResolveAt = null;
      patch.unknownSince = null;
    }
    // The secrets and the payment method token live only as long as the charge can still need them.
    if (to === 'COMPLETED' || to === 'FAILED' || to === 'CANCELLED') {
      patch.clientSecret = null;
      patch.paymentMethodToken = null;
      patch.requiresAction = false;
    }
    return patch;
  }

  private reasonFor(command: PaymentCommand): string | null {
    switch (command.type) {
      case 'fail':
        return command.code;
      case 'markUnknown':
      case 'cancel':
        return command.reason;
      case 'requestRefund':
        return 'order_cancelled'; // the only refund reason the order system sends
      default:
        return null;
    }
  }

  /** Ledger, outbox events and the resolution job of one applied move; all inside the transaction. */
  private async propagate(payment: PaymentRecord, now: Date): Promise<void> {
    const events = paymentEvents();
    const base = {
      paymentId: payment.id,
      orderId: payment.orderId,
      userId: payment.userId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      occurredAt: now.toISOString(),
      paymentVersion: payment.version,
    };
    switch (payment.status) {
      case 'COMPLETED': {
        // Money arrived for an order that is no longer payable: still published, and the order system refunds it.
        const copy = await this.orderCopies.find(payment.orderId);
        if (copy?.status === 'CANCELLED')
          completedForUnpayableOrderCounter.add();
        await this.ledger.recordCaptured(payment);
        await this.outbox.append(
          events.succeeded.create(payment.id, payment.version, {
            ...base,
            paymentRef: payment.providerRef ?? '',
          }),
        );
        return;
      }
      case 'FAILED':
      case 'CANCELLED':
        await this.outbox.append(
          events.failed.create(payment.id, payment.version, {
            ...base,
            paymentRef: payment.providerRef,
            reasonCode: payment.failureCode ?? 'provider_rejected',
          }),
        );
        return;
      case 'REFUNDED':
        await this.ledger.recordRefunded(payment);
        await this.outbox.append(
          events.refunded.create(payment.id, payment.version, {
            ...base,
            paymentRef: payment.providerRef ?? '',
          }),
        );
        return;
      case 'UNKNOWN':
        unknownOutcomesCounter.add();
        await this.jobs.enqueue(
          'payments.resolve-unknown',
          { paymentId: payment.id },
          {
            runAt: payment.nextResolveAt ?? now,
            idempotencyKey: `resolve:${payment.id}:${payment.resolveChecks}`,
          },
        );
        return;
      default:
        return;
    }
  }
}
