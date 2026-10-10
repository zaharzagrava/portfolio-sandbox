import { Injectable } from '@nestjs/common';
import type { PaymentStatus, PaymentStatusPort } from '../domain/ports';
import { PaymentStatusUnavailableError } from '../domain/order-errors';

/**
 * Default binding until the payments capability (S13) exports `getPaymentStatus`: it fails closed. A webhook for a
 * success is stored and retried and, after the last attempt, ends `FAILED`: an order is never marked `PAID` without
 * confirmation. S13 replaces this provider.
 */
@Injectable()
export class PaymentStatusUnavailableAdapter implements PaymentStatusPort {
  getPaymentStatus(_paymentRef: string): Promise<PaymentStatus> {
    return Promise.reject(new PaymentStatusUnavailableError());
  }
}
