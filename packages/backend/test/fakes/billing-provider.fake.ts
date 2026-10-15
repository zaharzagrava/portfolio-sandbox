import type { FakeClock } from '@app/common/core/clock';
import { getActiveTransaction } from '@app/infrastructure/context';

/** One create call as the provider saw it, plus the facts a spec asserts about the caller. */
export interface CreateCall {
  at: Date;
  amount: number;
  currency: string;
  paymentMethodId: string;
  idempotencyKey: string;
  metadata: Record<string, string> | undefined;
  timeoutMs: number | undefined;
  /** True when a database transaction was open in the caller (must never be, III.3). */
  insideTransaction: boolean;
}

export interface SearchCall {
  at: Date;
  pairs: Record<string, string>;
  timeoutMs: number;
}

interface HeldIntent {
  id: string;
  status: string;
  metadata: Record<string, string>;
  last_payment_error?: { code?: string; decline_code?: string } | null;
}

/** What the next create call does, instead of the behaviour its `pm_*` reference implies. */
export type CreateStep =
  | { kind: 'ok' }
  | { kind: 'card_error'; code: string; declineCode?: string }
  | { kind: 'timeout'; applied?: boolean }
  | { kind: 'server_error' }
  | { kind: 'answer'; body: unknown };

/**
 * The payment provider at the HTTP edge of the Stripe client (S17 test-plan.md). It answers by payment-method
 * reference as DS-1 says — `pm_ok` succeeds, `pm_declined` declines (`card_declined`), `pm_auth` needs the customer,
 * `pm_timeout` never answers, `pm_late` never answers but holds a succeeded charge for our key — and records every
 * call with the caller's transaction state. Errors have the shape of the SDK's own. Nothing above it is faked.
 */
export class FakeBillingProvider {
  readonly creates: CreateCall[] = [];
  readonly searches: SearchCall[] = [];
  /** Intents the provider holds, by idempotency key (`<invoiceId>:<attempt>`). */
  readonly held = new Map<string, HeldIntent>();
  /** Makes every search fail like an unreachable provider (`timeout`) or a `5xx`. */
  searchFault: 'timeout' | 'server_error' | null = null;
  private readonly steps: CreateStep[] = [];
  private sequence = 0;

  constructor(private readonly clock: Pick<FakeClock, 'now' | 'advance'>) {}

  reset(): void {
    this.creates.length = 0;
    this.searches.length = 0;
    this.held.clear();
    this.steps.length = 0;
    this.searchFault = null;
  }

  /** The next create calls do these steps in order; later calls follow their payment-method reference. */
  script(...steps: CreateStep[]): void {
    this.steps.push(...steps);
  }

  /** Puts a charge in the provider's books, as if a create call had been answered too late for us to hear it. */
  hold(
    key: string,
    metadata: Record<string, string>,
    status = 'succeeded',
    error?: HeldIntent['last_payment_error'],
  ): HeldIntent {
    const intent: HeldIntent = {
      id: `pi_held_${++this.sequence}`,
      status,
      metadata,
      last_payment_error: error ?? null,
    };
    this.held.set(key, intent);
    return intent;
  }

  /** Create calls made with this idempotency key (the "at most one per attempt" assertion). */
  callsFor(idempotencyKey: string): CreateCall[] {
    return this.creates.filter((c) => c.idempotencyKey === idempotencyKey);
  }

  private timeoutError(timeoutMs: number | undefined) {
    // The fake clock moves by the call's limit, as a real wait would.
    this.clock.advance(timeoutMs ?? 0);
    return Object.assign(new Error('Request timed out.'), {
      type: 'StripeConnectionError',
    });
  }

  async createPaymentIntent(params: {
    amount: number;
    currency: string;
    paymentMethodId: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
    timeoutMs?: number;
  }) {
    this.creates.push({
      at: this.clock.now(),
      amount: params.amount,
      currency: params.currency,
      paymentMethodId: params.paymentMethodId,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata,
      timeoutMs: params.timeoutMs,
      insideTransaction: getActiveTransaction() !== undefined,
    });
    // The provider dedupes on the key: the same key never creates a second charge.
    const existing = this.held.get(params.idempotencyKey);
    if (existing && existing.status === 'succeeded')
      return { id: existing.id, status: existing.status };

    const step = this.steps.shift() ?? this.stepFor(params.paymentMethodId);
    const metadata = params.metadata ?? {};
    switch (step.kind) {
      case 'ok': {
        const intent = this.hold(params.idempotencyKey, metadata);
        return { id: intent.id, status: intent.status };
      }
      case 'card_error':
        this.hold(params.idempotencyKey, metadata, 'requires_payment_method', {
          code: step.code,
          decline_code: step.declineCode,
        });
        throw Object.assign(new Error('Your card was declined.'), {
          type: 'StripeCardError',
          code: step.code,
          decline_code: step.declineCode,
          statusCode: 402,
        });
      case 'timeout':
        if (step.applied) this.hold(params.idempotencyKey, metadata);
        throw this.timeoutError(params.timeoutMs);
      case 'server_error':
        throw Object.assign(new Error('Internal error'), {
          type: 'StripeAPIError',
          statusCode: 500,
          requestId: 'req_test_500',
        });
      case 'answer':
        return step.body as { id?: unknown; status?: unknown };
    }
  }

  private stepFor(paymentMethodId: string): CreateStep {
    switch (paymentMethodId) {
      case 'pm_declined':
        return { kind: 'card_error', code: 'card_declined' };
      case 'pm_auth':
        return { kind: 'card_error', code: 'authentication_required' };
      case 'pm_timeout':
        return { kind: 'timeout' };
      case 'pm_late':
        return { kind: 'timeout', applied: true };
      case 'pm_mystery':
        return {
          kind: 'answer',
          body: { id: 'pi_mystery', status: 'mystery' },
        };
      case 'pm_garbage':
        return { kind: 'answer', body: null };
      default:
        return { kind: 'ok' };
    }
  }

  findPaymentIntentByMetadataPair(
    pairs: Record<string, string>,
    timeoutMs: number,
  ): Promise<HeldIntent | null> {
    this.searches.push({ at: this.clock.now(), pairs, timeoutMs });
    if (this.searchFault === 'timeout') {
      return Promise.reject(this.timeoutError(timeoutMs));
    }
    if (this.searchFault === 'server_error')
      return Promise.reject(
        Object.assign(new Error('Internal error'), {
          type: 'StripeAPIError',
          statusCode: 503,
        }),
      );
    for (const intent of this.held.values())
      if (Object.entries(pairs).every(([k, v]) => intent.metadata[k] === v))
        return Promise.resolve(intent);
    return Promise.resolve(null);
  }
}
