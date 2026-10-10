import { Injectable } from '@nestjs/common';
import { PaymentQueryService } from '@app/domains/payments';
import type { PaymentStatus, PaymentStatusPort } from '../domain/ports';
import { PaymentStatusUnavailableError } from '../domain/order-errors';

/**
 * The payments capability's `getPaymentStatus` (S13 R1) behind S10's port. A payment payments does not know yet (the
 * provider's webhook can arrive before the charge answer was recorded) is a retryable "not available": the webhook is
 * stored and tried again, an order is never marked `PAID` without confirmation. The payments service refreshes a
 * pending payment from the provider itself and never throws for provider trouble.
 */
@Injectable()
export class PaymentQueryStatusAdapter implements PaymentStatusPort {
  constructor(private readonly payments: PaymentQueryService) {}

  async getPaymentStatus(paymentRef: string): Promise<PaymentStatus> {
    let view;
    try {
      view = await this.payments.getPaymentStatus(paymentRef);
    } catch {
      throw new PaymentStatusUnavailableError();
    }
    if (!view) throw new PaymentStatusUnavailableError('payment not known yet');
    return {
      status: view.status,
      amountMinor: view.amountMinor,
      currency: view.currency,
    };
  }
}
