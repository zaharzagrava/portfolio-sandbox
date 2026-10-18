import type { IntentSnapshot } from '../domain/charge-outcome';

/** What the billing adapter needs from the provider SDK (the thin `StripeService` satisfies it; the doubles implement it). */
export interface BillingProviderTransport {
  createPaymentIntent(params: {
    amount: number;
    currency: string;
    paymentMethodId: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<IntentSnapshot>;
  findPaymentIntentByMetadataPair(
    pairs: Record<string, string>,
    timeoutMs: number,
  ): Promise<IntentSnapshot | null>;
}
