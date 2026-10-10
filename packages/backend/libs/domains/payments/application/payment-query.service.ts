import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  PaymentCurrency,
  PaymentView,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { classifyLookup } from '../domain/provider-outcome';
import {
  PAYMENT_PROVIDER,
  PAYMENT_REPOSITORY,
  REFRESH_GATE,
  type PaymentProvider,
  type PaymentRecord,
  type PaymentRepository,
  type RefreshGate,
} from '../domain/ports';
import type { PaymentStatus } from '../domain/payment-status';
import { PaymentNotFoundError } from '../domain/payment-errors';
import { PaymentResolutionService } from './payment-resolution.service';
import { PaymentTransitionService } from './payment-transition.service';

/** What the order system gets back (R1): four statuses, no secret, no owner, no failure detail, no payment method. */
export interface PaymentStatusView {
  paymentId: string;
  paymentRef: string;
  orderId: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED';
  amountMinor: number;
  currency: PaymentCurrency;
}

const VIEW_STATUS: Record<PaymentStatus, PaymentStatusView['status']> = {
  PENDING: 'PENDING',
  UNKNOWN: 'PENDING',
  COMPLETED: 'COMPLETED',
  REFUND_PENDING: 'COMPLETED',
  REFUNDED: 'REFUNDED',
  FAILED: 'FAILED',
  CANCELLED: 'FAILED',
};

const MAX_REF_LENGTH = 255;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The exported service of the payments capability (R1, S13 FR-038): the status of a payment by its provider reference,
 * for the order system's webhook confirmation. A payment that is not final is refreshed from the provider first (the
 * customer-action path has no other trigger): at most once per payment per 2 s across the fleet, within a 2 s call limit,
 * through the same guarded step as every other path. It never throws for provider or Redis trouble; it answers with the
 * stored status.
 */
@Injectable()
export class PaymentQueryService {
  private readonly logger = new Logger(PaymentQueryService.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(REFRESH_GATE) private readonly gate: RefreshGate,
    private readonly transitions: PaymentTransitionService,
    private readonly resolution: PaymentResolutionService,
    private readonly config: ApiConfigService,
  ) {}

  /**
   * `GET /payments/:id` (S13 FR-039): the caller's own payment as `paymentSchema`. Pure read: no refresh, no provider
   * call. Another buyer's payment, a missing one and a malformed ID are the same `404`.
   */
  async getOwned(userId: string, paymentId: string): Promise<PaymentView> {
    if (!UUID_PATTERN.test(paymentId)) throw new PaymentNotFoundError();
    const payment = await this.payments.findById(paymentId);
    if (!payment || payment.userId !== userId) throw new PaymentNotFoundError();
    const showSecret = payment.status === 'PENDING' && payment.requiresAction;
    return {
      id: payment.id,
      orderId: payment.orderId,
      status: payment.status,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      failureCode: payment.failureCode,
      requiresAction: payment.requiresAction,
      clientSecret: showSecret ? payment.clientSecret : null,
      version: payment.version,
      createdAt: payment.createdAt.toISOString(),
      updatedAt: payment.updatedAt.toISOString(),
    };
  }

  async getPaymentStatus(
    paymentRef: string,
  ): Promise<PaymentStatusView | null> {
    if (!paymentRef || paymentRef.length > MAX_REF_LENGTH) return null;
    let payment = await this.payments.findByProviderRef(paymentRef);
    if (!payment) return null;
    if (payment.status === 'PENDING' || payment.status === 'UNKNOWN')
      payment = await this.refresh(payment);
    return {
      paymentId: payment.id,
      paymentRef,
      orderId: payment.orderId,
      status: VIEW_STATUS[payment.status],
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    };
  }

  private async refresh(payment: PaymentRecord): Promise<PaymentRecord> {
    try {
      const mayRefresh = await this.gate.tryAcquire(
        payment.id,
        this.config.get('payments_refresh_min_interval_ms'),
      );
      if (!mayRefresh) return payment;

      if (payment.status === 'UNKNOWN') {
        await this.resolution.resolve(payment.id);
      } else {
        const outcome = classifyLookup(
          await this.provider.retrieveIntent(payment.providerRef!),
          {
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            orderId: payment.orderId,
          },
        );
        if (outcome.kind === 'succeeded')
          await this.transitions.apply(
            payment.id,
            { type: 'succeed' },
            'system:refresh',
            { providerRef: outcome.providerRef },
          );
        else if (outcome.kind === 'failed')
          await this.transitions.apply(
            payment.id,
            { type: 'fail', code: outcome.code },
            'system:refresh',
          );
      }
      return (await this.payments.findById(payment.id)) ?? payment;
    } catch (error) {
      this.logger.warn(
        `status refresh of payment ${payment.id} failed: ${(error as Error).message}`,
      );
      return (
        (await this.payments.findById(payment.id).catch(() => null)) ?? payment
      );
    }
  }
}
