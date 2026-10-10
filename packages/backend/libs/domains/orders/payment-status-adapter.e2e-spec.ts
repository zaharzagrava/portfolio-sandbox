import type { PaymentQueryService } from '@app/domains/payments';
import { PaymentStatusUnavailableError } from './domain/order-errors';
import { PaymentQueryStatusAdapter } from './infra/payment-status.adapter';

const adapter = (getPaymentStatus: PaymentQueryService['getPaymentStatus']) =>
  new PaymentQueryStatusAdapter({ getPaymentStatus } as PaymentQueryService);

describe('Payment status adapter (S13 R1 behind the S10 port)', () => {
  it('S13: maps the payments view to the port and drops the identifiers', async () => {
    const view = {
      paymentId: 'p',
      paymentRef: 'pi_1',
      orderId: 'o',
      status: 'COMPLETED' as const,
      amountMinor: 2_500,
      currency: 'EUR' as const,
    };
    await expect(
      adapter(() => Promise.resolve(view)).getPaymentStatus('pi_1'),
    ).resolves.toEqual({
      status: 'COMPLETED',
      amountMinor: 2_500,
      currency: 'EUR',
    });
  });

  it('S13: a payment payments does not know yet, or a failure of the service, is the retryable "not available"', async () => {
    await expect(
      adapter(() => Promise.resolve(null)).getPaymentStatus('pi_x'),
    ).rejects.toBeInstanceOf(PaymentStatusUnavailableError);
    await expect(
      adapter(() => Promise.reject(new Error('boom'))).getPaymentStatus('pi_x'),
    ).rejects.toBeInstanceOf(PaymentStatusUnavailableError);
  });
});
