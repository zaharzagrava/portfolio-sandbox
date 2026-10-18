import type { IntentSnapshot } from '../domain/charge-outcome';
import type { BillingProviderTransport } from './billing-provider-transport';

interface Held extends IntentSnapshot {
  metadata: Record<string, string>;
}

/**
 * The payment provider of the local profile (`PROVIDER_DOUBLES=enabled`, refused in production by the config rules; J02
 * G-17). Answers by payment-method reference like the order payments double does: `pm_test_declined` is a card error,
 * `pm_test_timeout` never answers in time (and nothing is charged), everything else (`pm_test_visa` ...) succeeds. The
 * provider dedupes on the idempotency key, so a retried attempt never charges twice. Errors have the shape of the SDK's own,
 * which is what the adapter classifies.
 */
export class ScriptedBillingTransport implements BillingProviderTransport {
  private readonly held = new Map<string, Held>();
  private sequence = 0;
  /** Charges the provider has taken (a spec asserts "at most one per key"). */
  created = 0;

  async createPaymentIntent(params: {
    amount: number;
    currency: string;
    paymentMethodId: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<IntentSnapshot> {
    const existing = this.held.get(params.idempotencyKey);
    if (existing) return { id: existing.id, status: existing.status };

    if (params.paymentMethodId === 'pm_test_declined')
      throw Object.assign(new Error('Your card was declined.'), {
        type: 'StripeCardError',
        code: 'card_declined',
        decline_code: 'generic_decline',
        statusCode: 402,
      });
    if (params.paymentMethodId === 'pm_test_timeout') {
      // the caller's own limit, as a real wait would take (never longer than a few seconds in a double)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(params.timeoutMs ?? 0, 5_000)),
      );
      throw Object.assign(new Error('Request timed out.'), {
        type: 'StripeConnectionError',
      });
    }
    const intent: Held = {
      id: `pi_scripted_${++this.sequence}`,
      status: 'succeeded',
      metadata: params.metadata ?? {},
    };
    this.held.set(params.idempotencyKey, intent);
    this.created += 1;
    return { id: intent.id, status: intent.status };
  }

  findPaymentIntentByMetadataPair(
    pairs: Record<string, string>,
    _timeoutMs: number,
  ): Promise<IntentSnapshot | null> {
    for (const intent of this.held.values())
      if (Object.entries(pairs).every(([k, v]) => intent.metadata[k] === v))
        return Promise.resolve({ id: intent.id, status: intent.status });
    return Promise.resolve(null);
  }
}
