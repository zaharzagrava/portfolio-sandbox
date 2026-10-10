import { Injectable } from '@nestjs/common';
import { InboxService } from '@app/infrastructure/inbox';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import type { RefundCommandPort } from '../domain/ports';

export const REFUND_REQUESTED_QUEUE = 'orders-refund-requested';
export const REFUND_REQUESTED_TYPE = 'orders.refund_requested';

/**
 * Asks the payments capability to refund a genuine payment that met a cancelled order (S10 FR-040). Once per payment:
 * the inbox marker `refund:<paymentRef>` and the task row commit together in the caller's transaction.
 */
@Injectable()
export class RefundCommandAdapter implements RefundCommandPort {
  constructor(
    private readonly outbox: OutboxService,
    private readonly inbox: InboxService,
  ) {}

  async requestRefund(command: {
    orderId: string;
    paymentRef: string;
    amountMinor: number;
    currency: string;
  }): Promise<void> {
    if (
      !(await this.inbox.recordOnce(
        'orders.refund-request',
        command.paymentRef,
      ))
    )
      return;
    await this.outbox.appendTask({
      queue: REFUND_REQUESTED_QUEUE,
      type: REFUND_REQUESTED_TYPE,
      aggregateId: command.orderId,
      groupId: command.orderId,
      body: {
        orderId: command.orderId,
        paymentRef: command.paymentRef,
        amountMinor: command.amountMinor,
        currency: command.currency,
        reason: 'order_cancelled',
      },
    });
  }
}
