import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { PaymentAccepted } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { checkPayable } from '../domain/order-copy';
import { checkPaymentMoney } from '../domain/payment-amount';
import {
  AmountOutOfRangeError,
  CurrencyUnsupportedError,
  OrderNotFoundError,
  OrderNotPayableError,
  PaymentAlreadyExistsError,
} from '../domain/payment-errors';
import { paymentsCreatedCounter } from '../domain/payment-metrics';
import {
  PAYMENT_HISTORY_REPOSITORY,
  PAYMENT_REPOSITORY,
  type PaymentHistoryRepository,
  type PaymentRepository,
} from '../domain/ports';
import { OrderCopyService } from './order-copy.service';

export const CHARGE_QUEUE = 'payments-charge';
export const CHARGE_REQUESTED_TYPE = 'payments.charge_requested';

/**
 * `POST /payments/intents` (S13 US1): accepts a payment for a reserved order exactly once and does nothing else. The
 * amount and currency are the order's own (the order copy), never the caller's. One transaction writes the payment,
 * its first history row and the charge command; the provider is not called here.
 */
@Injectable()
export class PaymentIntentService {
  constructor(
    private readonly orderCopies: OrderCopyService,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(PAYMENT_HISTORY_REPOSITORY)
    private readonly history: PaymentHistoryRepository,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async accept(
    userId: string,
    input: { orderId: string; paymentMethodId: string },
  ): Promise<PaymentAccepted> {
    const copy = await this.orderCopies.waitFor(input.orderId, userId);
    if (!copy) throw new OrderNotFoundError();

    const payable = checkPayable(copy, this.clock.now());
    if (!payable.payable) throw new OrderNotPayableError(payable.reason);

    const money = checkPaymentMoney(payable.totalMinor, payable.currency);
    if (money.kind === 'amount_out_of_range') throw new AmountOutOfRangeError();
    if (money.kind === 'currency_unsupported')
      throw new CurrencyUnsupportedError();

    const id = uuidv7();
    const now = this.clock.now();
    const created = await this.runner.run(async () => {
      const payment = await this.payments.insertAccepted({
        id,
        userId,
        orderId: input.orderId,
        amountMinor: money.amountMinor,
        currency: money.currency,
        paymentMethodToken: input.paymentMethodId,
        now,
      });
      if (!payment) {
        const existing = await this.payments.findByOrderId(input.orderId);
        throw new PaymentAlreadyExistsError(existing?.id ?? '');
      }
      await this.history.insert({
        paymentId: id,
        version: 1,
        fromStatus: null,
        toStatus: 'PENDING',
        reason: null,
        actor: `user:${userId}`,
        at: now,
      });
      await this.outbox.appendTask({
        queue: CHARGE_QUEUE,
        type: CHARGE_REQUESTED_TYPE,
        aggregateId: id,
        groupId: id,
        body: { paymentId: id, attempt: 0 },
      });
      return payment;
    });
    paymentsCreatedCounter.add(1, { result: 'accepted' });

    return {
      paymentId: created.id,
      orderId: created.orderId,
      status: 'PENDING',
      amountMinor: created.amountMinor,
      currency: created.currency,
      createdAt: created.createdAt.toISOString(),
    };
  }
}
