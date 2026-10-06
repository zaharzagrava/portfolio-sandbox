import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import BisOrder from './models/bis-order.model';
import { PaymentStatus } from '@app/domains/payments';
import { KafkaTopicGroup } from '@app/infrastructure/outbox/outbox.model';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { OrderService } from '../application/order.service';

interface PaymentResponse {
  payload?: { bisOrderId?: string };
  extra?: { payment?: { id: string; status: PaymentStatus } };
}

/**
 * Saga step (README #8 extended): `payments.responses` from the payment
 * processor drive the order: COMPLETED → PAID (reservations converted),
 * FAILED/REFUNDED → CANCELLED (stock released = compensation). Runs on the
 * F-05 consumer framework (own group, DLQ, retries); idempotent because
 * transitions are status-guarded.
 */
@Injectable()
export class OrderPaymentListener implements Projector {
  private readonly logger = new Logger(OrderPaymentListener.name);
  readonly name = 'order-payment-listener';
  readonly topics = [KafkaTopicGroup.PAYMENTS_RESPONSES];

  constructor(
    private readonly orders: OrderService,
    @InjectModel(BisOrder) private readonly orderModel: typeof BisOrder,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const event of events) {
      const message = event.payload as PaymentResponse;
      const orderId = message.payload?.bisOrderId;
      const payment = message.extra?.payment;
      if (!orderId || !payment) continue;

      // Only checkout orders (created by SD-19) have a state machine; legacy orders are left alone.
      const order = await this.orderModel.findByPk(orderId, { attributes: ['id', 'idempotencyKey'] });
      if (!order?.idempotencyKey) continue;

      try {
        if (payment.status === PaymentStatus.COMPLETED) await this.orders.markPaid(orderId, payment.id);
        else if (payment.status === PaymentStatus.FAILED || payment.status === PaymentStatus.REFUNDED) await this.orders.cancel(orderId, 'payment_failed');
      } catch (error) {
        // e.g. payment completed after the hold expired: the order is CANCELLED → needs a refund (logged for the finance queue, SD-20).
        if (error instanceof ConflictException) this.logger.warn(`order ${orderId}: ${(error as Error).message}`);
        else throw error;
      }
    }
  }
}
