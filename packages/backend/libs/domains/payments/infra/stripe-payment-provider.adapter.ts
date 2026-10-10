import { Inject, Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { CircuitBreaker, CircuitOpenError } from '@app/common/resilience';
import { assertNoActiveTransaction } from '@app/infrastructure/context';
import type { CreateIntentInput, PaymentProvider } from '../domain/ports';
import type {
  IntentSnapshot,
  ProviderResponse,
} from '../domain/provider-outcome';
import {
  breakerOpenGauge,
  providerCallsCounter,
} from '../domain/payment-metrics';

/** What the adapter needs from the provider SDK (the thin `StripeService` satisfies it; the e2e kit swaps in a scripted double). */
export interface TransportIntent {
  id: string;
  status?: string;
  amount?: number;
  currency?: string;
  metadata?: Record<string, string> | null;
  client_secret?: string | null;
  last_payment_error?: { code?: string; decline_code?: string } | null;
}

export interface ProviderTransport {
  createPaymentIntent(params: {
    amount: number;
    currency: string;
    paymentMethodId: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<TransportIntent>;
  retrievePaymentIntent(
    intentId: string,
    timeoutMs: number,
  ): Promise<TransportIntent>;
  findPaymentIntentByMetadata(
    key: string,
    value: string,
    timeoutMs: number,
  ): Promise<TransportIntent | null>;
  cancelPaymentIntent(
    intentId: string,
    idempotencyKey: string,
    timeoutMs: number,
  ): Promise<TransportIntent>;
  createRefund(
    intentId: string,
    idempotencyKey: string,
    timeoutMs: number,
  ): Promise<TransportRefund>;
  listRefunds(intentId: string, timeoutMs: number): Promise<TransportRefund[]>;
}

export interface TransportRefund {
  id: string;
  status?: string | null;
  amount?: number;
}

export const PROVIDER_TRANSPORT = Symbol('PROVIDER_TRANSPORT');

export type BreakerName =
  'create_intent' | 'retrieve_intent' | 'cancel_intent' | 'refund';

const BREAKERS: BreakerName[] = [
  'create_intent',
  'retrieve_intent',
  'cancel_intent',
  'refund',
];

/** A failure the breaker counts (timeout, connection, `5xx`, `429`); carries the answer the caller classifies. */
class ProviderFailure extends Error {
  constructor(readonly response: ProviderResponse) {
    super('provider call failed');
  }
}

interface SdkError {
  type?: string;
  code?: string;
  decline_code?: string;
  statusCode?: number;
  requestId?: string;
  message?: string;
  detail?: { code?: string };
  raw?: { requestId?: string };
}

const CONNECT_FAILURES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Provider answer or error → `ProviderResponse`; `failure` says whether the breaker counts it (A9, A12). */
export function mapProviderError(error: unknown): {
  response: ProviderResponse;
  failure: boolean;
} {
  const e = (error ?? {}) as SdkError;
  const requestId = e.requestId ?? e.raw?.requestId;
  if (e.type === 'StripeCardError')
    return {
      response: {
        kind: 'card_error',
        ...(e.code && { code: e.code }),
        ...(e.decline_code && { declineCode: e.decline_code }),
      },
      failure: false,
    };
  if (e.type === 'StripeRateLimitError' || e.statusCode === 429)
    return {
      response: {
        kind: 'http_error',
        httpStatus: 429,
        ...(requestId && { requestId }),
      },
      failure: true,
    };
  if (e.type === 'StripeConnectionError') {
    const code = e.detail?.code ?? e.code;
    if (code && CONNECT_FAILURES.has(code))
      return {
        response: { kind: 'not_sent', reason: 'connect_failed' },
        failure: true,
      };
    return {
      response: {
        kind: 'ambiguous',
        reason: /time(d)?\s?out/i.test(e.message ?? '') ? 'timeout' : 'network',
      },
      failure: true,
    };
  }
  if (e.type === 'StripeAPIError' || (e.statusCode ?? 0) >= 500)
    return {
      response: { kind: 'ambiguous', reason: 'server_error' },
      failure: true,
    };
  if (e.statusCode !== undefined && e.statusCode >= 400)
    return {
      response: {
        kind: 'http_error',
        httpStatus: e.statusCode,
        ...(requestId && { requestId }),
        ...(e.code && { code: e.code }),
      },
      failure: false,
    };
  return {
    response: { kind: 'ambiguous', reason: 'malformed' },
    failure: true,
  };
}

const snapshot = (i: TransportIntent): IntentSnapshot => ({
  id: i.id,
  status: i.status,
  amountMinor: i.amount,
  currency: i.currency,
  orderId: i.metadata?.orderId,
  clientSecret: i.client_secret ?? null,
  lastErrorCode: i.last_payment_error?.code ?? null,
  lastDeclineCode: i.last_payment_error?.decline_code ?? null,
});

/**
 * The payment provider behind the port (S13 A9, A12, A24): one circuit breaker per operation, a call limit per
 * operation, zero SDK retries (the charge retry is the only retry layer), and every answer turned into a
 * `ProviderResponse` the pure classifier understands. Card declines and `4xx` are answers, not breaker failures; timeouts,
 * connection errors, `5xx`, `429` and slow calls are. An open breaker answers `not_sent` without touching the provider.
 */
@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  private breakers: Record<BreakerName, CircuitBreaker>;

  constructor(
    @Inject(PROVIDER_TRANSPORT) private readonly transport: ProviderTransport,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.breakers = this.buildBreakers();
  }

  /** Closes every breaker again. For specs that move the clock back and forth; nothing in production calls it. */
  resetBreakers(): void {
    this.breakers = this.buildBreakers();
  }

  private buildBreakers(): Record<BreakerName, CircuitBreaker> {
    const { config, clock } = this;
    const options = (name: BreakerName) => ({
      name: `payments.${name}`,
      clock,
      windowMs: config.get('payments_breaker_window_ms'),
      minimumCalls: config.get('payments_breaker_min_calls'),
      failureRateThreshold: config.get('payments_breaker_failure_pct') / 100,
      slowCallMs: config.get('payments_breaker_slow_ms'),
      openDurationMs: config.get('payments_breaker_open_ms'),
      halfOpenCalls: 1,
      isFailure: (error: unknown) => error instanceof ProviderFailure,
    });
    for (const b of BREAKERS) breakerOpenGauge.set(0, { breaker: b });
    return Object.fromEntries(
      BREAKERS.map((b) => [b, new CircuitBreaker(options(b))]),
    ) as Record<BreakerName, CircuitBreaker>;
  }

  createIntent(input: CreateIntentInput): Promise<ProviderResponse> {
    return this.run('create_intent', async () => {
      const intent = await this.transport.createPaymentIntent({
        amount: input.amountMinor,
        currency: input.currency,
        paymentMethodId: input.paymentMethodToken,
        idempotencyKey: input.referenceKey,
        metadata: { orderId: input.orderId, paymentId: input.paymentId },
        timeoutMs: this.config.get('payments_create_timeout_ms'),
      });
      return { kind: 'intent', intent: snapshot(intent) };
    });
  }

  retrieveIntent(intentId: string): Promise<ProviderResponse> {
    return this.run('retrieve_intent', async () => {
      const intent = await this.transport.retrievePaymentIntent(
        intentId,
        this.config.get('payments_refresh_timeout_ms'),
      );
      return { kind: 'intent', intent: snapshot(intent) };
    });
  }

  findIntentByReference(orderId: string): Promise<ProviderResponse> {
    return this.run('retrieve_intent', async () => {
      const intent = await this.transport.findPaymentIntentByMetadata(
        'orderId',
        orderId,
        this.config.get('payments_lookup_timeout_ms'),
      );
      return intent
        ? { kind: 'intent', intent: snapshot(intent) }
        : { kind: 'not_found' };
    });
  }

  cancelIntent(intentId: string, key: string): Promise<ProviderResponse> {
    return this.run('cancel_intent', async () => {
      const intent = await this.transport.cancelPaymentIntent(
        intentId,
        key,
        this.config.get('payments_cancel_timeout_ms'),
      );
      return { kind: 'intent', intent: snapshot(intent) };
    });
  }

  createRefund(intentId: string, key: string): Promise<ProviderResponse> {
    return this.run('refund', async () => {
      const refund = await this.transport.createRefund(
        intentId,
        key,
        this.config.get('payments_refund_timeout_ms'),
      );
      return {
        kind: 'refund',
        refund: {
          id: refund.id,
          status: refund.status ?? undefined,
          amountMinor: refund.amount,
        },
      };
    });
  }

  findRefunds(intentId: string): Promise<ProviderResponse> {
    return this.run('refund', async () => {
      const refunds = await this.transport.listRefunds(
        intentId,
        this.config.get('payments_lookup_timeout_ms'),
      );
      return {
        kind: 'refunds',
        refunds: refunds.map((r) => ({
          id: r.id,
          status: r.status ?? undefined,
          amountMinor: r.amount,
        })),
      };
    });
  }

  /** Current state of a breaker, for the gauge and the specs. */
  breakerState(name: BreakerName) {
    return this.breakers[name].state();
  }

  private async run(
    name: BreakerName,
    call: () => Promise<ProviderResponse>,
  ): Promise<ProviderResponse> {
    // A provider call holds a database connection for as long as the provider takes if a transaction is open (III.3).
    assertNoActiveTransaction('network');
    const breaker = this.breakers[name];
    const operation = name;
    try {
      const { value } = await breaker.execute(async () => {
        try {
          return await call();
        } catch (error) {
          const mapped = mapProviderError(error);
          if (mapped.failure) throw new ProviderFailure(mapped.response);
          return mapped.response;
        }
      });
      providerCallsCounter.add(1, { operation, outcome: value.kind });
      return value;
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        providerCallsCounter.add(1, { operation, outcome: 'not_sent' });
        return { kind: 'not_sent', reason: 'circuit_open' };
      }
      if (error instanceof ProviderFailure) {
        providerCallsCounter.add(1, {
          operation,
          outcome: error.response.kind,
        });
        return error.response;
      }
      throw error;
    } finally {
      breakerOpenGauge.set(breaker.state() === 'OPEN' ? 1 : 0, {
        breaker: name,
      });
    }
  }
}
