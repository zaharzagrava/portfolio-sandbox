import { Injectable } from '@nestjs/common';
import type { CreateIntentInput, PaymentProvider } from '../domain/ports';
import type { ProviderResponse } from '../domain/provider-outcome';

/**
 * The provider for the load-test environment (`is_load_test`), bound by DI in place of the Stripe adapter (S13 A23): every
 * charge succeeds at once, lookups find nothing, refunds succeed. It replaces the `is_load_test` branches that used to sit
 * inside the thin Stripe client. Never bound outside that environment.
 */
@Injectable()
export class LoadTestPaymentProvider implements PaymentProvider {
  private readonly intents = new Map<string, ProviderResponse>();

  createIntent(input: CreateIntentInput): Promise<ProviderResponse> {
    const response: ProviderResponse = {
      kind: 'intent',
      intent: {
        id: `pi_loadtest_${input.orderId}`,
        status: 'succeeded',
        amountMinor: input.amountMinor,
        currency: input.currency.toLowerCase(),
        orderId: input.orderId,
        clientSecret: null,
      },
    };
    this.intents.set(response.intent.id, response);
    return Promise.resolve(response);
  }

  retrieveIntent(intentId: string): Promise<ProviderResponse> {
    return Promise.resolve(this.intents.get(intentId) ?? { kind: 'not_found' });
  }

  findIntentByReference(orderId: string): Promise<ProviderResponse> {
    return Promise.resolve(
      this.intents.get(`pi_loadtest_${orderId}`) ?? { kind: 'not_found' },
    );
  }

  cancelIntent(intentId: string): Promise<ProviderResponse> {
    return Promise.resolve({
      kind: 'intent',
      intent: {
        id: intentId,
        status: 'canceled',
        amountMinor: undefined,
        currency: undefined,
        orderId: undefined,
      },
    });
  }

  createRefund(): Promise<ProviderResponse> {
    return Promise.resolve({
      kind: 'refund',
      refund: {
        id: 're_loadtest',
        status: 'succeeded',
        amountMinor: undefined,
      },
    });
  }

  findRefunds(): Promise<ProviderResponse> {
    return Promise.resolve({ kind: 'refunds', refunds: [] });
  }
}
