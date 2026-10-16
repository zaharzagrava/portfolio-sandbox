import type { CreateIntentInput, PaymentProvider } from '../domain/ports';
import type {
  IntentSnapshot,
  ProviderResponse,
} from '../domain/provider-outcome';

/** How long `pm_test_slow` takes to answer. */
export const SLOW_CHARGE_MS = 8_000;

/** The clock the scripted provider waits on: a real timer, so the answer never depends on the platform clock offset. */
export interface ScriptedTimer {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realTimer: ScriptedTimer = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface Scripted {
  intent: IntentSnapshot;
  /** Set for a slow charge: the intent is `processing` until this instant. */
  readyAt: number;
}

/**
 * The payment provider of the local/test profile (`PROVIDER_DOUBLES=enabled`, S13.R-31), bound to the same port as the
 * Stripe adapter. The behavior is chosen by the payment method id: `pm_test_declined` is a definite decline,
 * `pm_test_slow` answers after 8 s, `pm_test_timeout` gives no answer (the timeout the real adapter reports), anything
 * else succeeds. Lookups agree with the script. The charge keeps the order's currency. State is per process.
 */
export class ScriptedPaymentProvider implements PaymentProvider {
  private readonly byIntent = new Map<string, Scripted>();

  constructor(private readonly timer: ScriptedTimer = realTimer) {}

  async createIntent(input: CreateIntentInput): Promise<ProviderResponse> {
    switch (input.paymentMethodToken) {
      case 'pm_test_declined':
        return { kind: 'card_error', code: 'card_declined' };
      case 'pm_test_timeout':
        return { kind: 'ambiguous', reason: 'timeout' };
      case 'pm_test_slow': {
        this.remember(input, SLOW_CHARGE_MS);
        await this.timer.sleep(SLOW_CHARGE_MS);
        return this.answer(input.orderId);
      }
      default:
        this.remember(input, 0);
        return this.answer(input.orderId);
    }
  }

  retrieveIntent(intentId: string): Promise<ProviderResponse> {
    const scripted = this.byIntent.get(intentId);
    return Promise.resolve(
      scripted ? this.view(scripted) : { kind: 'not_found' },
    );
  }

  findIntentByReference(orderId: string): Promise<ProviderResponse> {
    return this.retrieveIntent(intentIdOf(orderId));
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

  createRefund(intentId: string, _key: string): Promise<ProviderResponse> {
    return Promise.resolve({
      kind: 'refund',
      refund: {
        id: `re_scripted_${intentId}`,
        status: 'succeeded',
        amountMinor: this.byIntent.get(intentId)?.intent.amountMinor,
      },
    });
  }

  findRefunds(intentId: string): Promise<ProviderResponse> {
    const scripted = this.byIntent.get(intentId);
    return Promise.resolve({
      kind: 'refunds',
      refunds: scripted
        ? [
            {
              id: `re_scripted_${intentId}`,
              status: 'succeeded',
              amountMinor: scripted.intent.amountMinor,
            },
          ]
        : [],
    });
  }

  private remember(input: CreateIntentInput, delayMs: number): void {
    const id = intentIdOf(input.orderId);
    if (this.byIntent.has(id)) return;
    this.byIntent.set(id, {
      readyAt: this.timer.now() + delayMs,
      intent: {
        id,
        status: 'succeeded',
        amountMinor: input.amountMinor,
        currency: input.currency.toLowerCase(),
        orderId: input.orderId,
        clientSecret: null,
      },
    });
  }

  private answer(orderId: string): ProviderResponse {
    return {
      kind: 'intent',
      intent: { ...this.byIntent.get(intentIdOf(orderId))!.intent },
    };
  }

  private view(scripted: Scripted): ProviderResponse {
    const ready = this.timer.now() >= scripted.readyAt;
    return {
      kind: 'intent',
      intent: {
        ...scripted.intent,
        status: ready ? 'succeeded' : 'processing',
      },
    };
  }
}

const intentIdOf = (orderId: string): string => `pi_scripted_${orderId}`;
