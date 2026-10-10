import type { FakeClock } from '@app/common/core/clock';
import type {
  ProviderTransport,
  TransportIntent,
  TransportRefund,
} from '../infra/stripe-payment-provider.adapter';

export type ProviderOp =
  'create' | 'retrieve' | 'find' | 'cancel' | 'refund' | 'refunds';

/** What one scripted call does. Anything not scripted behaves like a healthy provider. */
export type ProviderStep =
  /** Answers with an intent of this status (default `succeeded`); `overrides` replaces fields of the answer. */
  | { kind: 'ok'; status?: string; overrides?: Partial<TransportIntent> }
  | { kind: 'card_error'; code: string; declineCode?: string }
  /** An error response with this HTTP status (`400`, `401`, `429`, `500`, `503` ...) and optional error code. */
  | { kind: 'http'; statusCode: number; requestId?: string; code?: string }
  /**
   * The call never answers within its limit. `applied: true` means the provider did create the intent (the answer was
   * lost on the way back). The fake clock moves by the call's timeout, as a real wait would.
   */
  | { kind: 'timeout'; applied?: boolean }
  | { kind: 'connect_refused' }
  /** Blocks on the gate (`wait()`) until a spec opens it, then answers like a healthy provider. */
  | { kind: 'hang'; gate: Gate }
  /** Takes `ms` of fake time, then answers like a healthy provider. */
  | { kind: 'slow'; ms: number };

export interface ProviderCall {
  op: ProviderOp;
  at: Date;
  timeoutMs: number | undefined;
  /** Create: the order id; others: the intent id or the searched value. */
  subject: string;
  idempotencyKey?: string;
  args: unknown;
}

/**
 * The provider's SDK as the payments adapter sees it, scripted per call: answers, declines, customer action, `5xx`,
 * timeouts, hangs, with a timestamped call log. The breaker, the call limits, the classification and the state machine
 * run for real above it (S13 test-plan.md); nothing here knows about them. Errors have the shape of the SDK's own
 * (`type`, `statusCode`, `code`, `decline_code`).
 */
export class FakeProviderTransport implements ProviderTransport {
  readonly calls: ProviderCall[] = [];
  /** Called as each call arrives (before it is answered): lets a spec observe the caller's context. */
  onCall: ((call: ProviderCall) => void) | null = null;
  /** Intents the provider holds, by id. */
  readonly intents = new Map<string, TransportIntent>();
  private readonly scripts: Record<ProviderOp, ProviderStep[]> = {
    create: [],
    retrieve: [],
    find: [],
    cancel: [],
    refund: [],
    refunds: [],
  };
  /** Refunds the provider holds, by intent id; created ones are deduped by their idempotency key. */
  readonly refunds = new Map<string, TransportRefund[]>();
  private readonly refundKeys = new Map<string, TransportRefund>();
  private readonly byKey = new Map<string, string>();
  private sequence = 0;

  constructor(private readonly clock: Pick<FakeClock, 'now' | 'advance'>) {}

  /** The next calls of `op` do these steps, in order; later calls are healthy. */
  script(op: ProviderOp, ...steps: ProviderStep[]): void {
    this.scripts[op].push(...steps);
  }

  /** The same step for the next `times` calls of `op`. */
  scriptRepeat(op: ProviderOp, step: ProviderStep, times: number): void {
    for (let i = 0; i < times; i++) this.scripts[op].push(step);
  }

  reset(): void {
    this.onCall = null;
    this.calls.length = 0;
    this.intents.clear();
    this.refunds.clear();
    this.refundKeys.clear();
    this.byKey.clear();
    for (const op of Object.keys(this.scripts) as ProviderOp[])
      this.scripts[op].length = 0;
    this.sequence = 0;
  }

  count(op: ProviderOp): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  /** Puts an intent at the provider without any call (a charge that exists although we have no record of it). */
  seedIntent(
    intent: Partial<TransportIntent> & { orderId: string },
  ): TransportIntent {
    const full: TransportIntent = {
      id: intent.id ?? `pi_seed_${++this.sequence}`,
      status: intent.status ?? 'succeeded',
      amount: intent.amount,
      currency: intent.currency ?? 'eur',
      metadata: { orderId: intent.orderId, ...(intent.metadata ?? {}) },
      client_secret: intent.client_secret ?? null,
      last_payment_error: intent.last_payment_error ?? null,
    };
    this.intents.set(full.id, full);
    return full;
  }

  // ------------------------------------------------------------ transport

  async createPaymentIntent(params: {
    amount: number;
    currency: string;
    paymentMethodId: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<TransportIntent> {
    const step = this.begin('create', params.timeoutMs, {
      subject: params.metadata?.orderId ?? params.idempotencyKey,
      idempotencyKey: params.idempotencyKey,
      args: {
        amount: params.amount,
        currency: params.currency,
        paymentMethodId: params.paymentMethodId,
        metadata: params.metadata,
      },
    });
    const make = () => {
      const existing = this.byKey.get(params.idempotencyKey);
      if (existing) return this.intents.get(existing)!;
      const intent: TransportIntent = {
        id: `pi_${++this.sequence}`,
        status: 'succeeded',
        amount: params.amount,
        currency: params.currency.toLowerCase(),
        metadata: params.metadata ?? {},
        client_secret: null,
        last_payment_error: null,
      };
      this.intents.set(intent.id, intent);
      this.byKey.set(params.idempotencyKey, intent.id);
      return intent;
    };
    return this.answer(step, params.timeoutMs, make);
  }

  async retrievePaymentIntent(
    intentId: string,
    timeoutMs: number,
  ): Promise<TransportIntent> {
    const step = this.begin('retrieve', timeoutMs, {
      subject: intentId,
      args: { intentId },
    });
    return this.answer(step, timeoutMs, () => {
      const found = this.intents.get(intentId);
      if (!found)
        throw {
          type: 'StripeInvalidRequestError',
          statusCode: 404,
          code: 'resource_missing',
        };
      return found;
    });
  }

  async findPaymentIntentByMetadata(
    key: string,
    value: string,
    timeoutMs: number,
  ): Promise<TransportIntent | null> {
    const step = this.begin('find', timeoutMs, {
      subject: value,
      args: { key, value },
    });
    const found = await this.answer(step, timeoutMs, () => {
      const intent = [...this.intents.values()].find(
        (i) => i.metadata?.[key] === value,
      );
      return intent ?? (null as unknown as TransportIntent);
    });
    return found ?? null;
  }

  async cancelPaymentIntent(
    intentId: string,
    idempotencyKey: string,
    timeoutMs: number,
  ): Promise<TransportIntent> {
    const step = this.begin('cancel', timeoutMs, {
      subject: intentId,
      idempotencyKey,
      args: { intentId },
    });
    return this.answer(step, timeoutMs, () => {
      const intent = this.intents.get(intentId);
      if (!intent)
        throw {
          type: 'StripeInvalidRequestError',
          statusCode: 404,
          code: 'resource_missing',
        };
      if (intent.status === 'succeeded')
        throw {
          type: 'StripeInvalidRequestError',
          statusCode: 400,
          code: 'payment_intent_unexpected_state',
        };
      intent.status = 'canceled';
      return intent;
    });
  }

  async createRefund(
    intentId: string,
    idempotencyKey: string,
    timeoutMs: number,
  ): Promise<TransportRefund> {
    const step = this.begin('refund', timeoutMs, {
      subject: intentId,
      idempotencyKey,
      args: { intentId },
    });
    return this.answer(step, timeoutMs, () => {
      const same = this.refundKeys.get(idempotencyKey);
      if (same) return same;
      const intent = this.intents.get(intentId);
      if (!intent)
        throw {
          type: 'StripeInvalidRequestError',
          statusCode: 404,
          code: 'resource_missing',
        };
      if ((this.refunds.get(intentId) ?? []).length > 0)
        throw {
          type: 'StripeInvalidRequestError',
          statusCode: 400,
          code: 'charge_already_refunded',
        };
      const refund: TransportRefund = {
        id: `re_${++this.sequence}`,
        status: 'succeeded',
        amount: intent.amount,
      };
      this.refundKeys.set(idempotencyKey, refund);
      this.refunds.set(intentId, [refund]);
      return refund;
    });
  }

  async listRefunds(
    intentId: string,
    timeoutMs: number,
  ): Promise<TransportRefund[]> {
    const step = this.begin('refunds', timeoutMs, {
      subject: intentId,
      args: { intentId },
    });
    return this.answer(step, timeoutMs, () => [
      ...(this.refunds.get(intentId) ?? []),
    ]) as Promise<TransportRefund[]>;
  }

  // -------------------------------------------------------------- helpers

  private begin(
    op: ProviderOp,
    timeoutMs: number | undefined,
    call: Omit<ProviderCall, 'op' | 'at' | 'timeoutMs'>,
  ): ProviderStep | undefined {
    const entry = { op, at: this.clock.now(), timeoutMs, ...call };
    this.calls.push(entry);
    this.onCall?.(entry);
    return this.scripts[op].shift();
  }

  private async answer<T extends object>(
    step: ProviderStep | undefined,
    timeoutMs: number | undefined,
    healthy: () => T,
  ): Promise<T> {
    if (!step) return healthy();
    switch (step.kind) {
      case 'ok': {
        // The provider's own record changes with the answer: what it says now is what it holds.
        const record = healthy();
        if (step.status && record)
          (record as { status?: string }).status = step.status;
        if (record) Object.assign(record, step.overrides ?? {});
        return record;
      }
      case 'card_error':
        throw {
          type: 'StripeCardError',
          code: step.code,
          decline_code: step.declineCode,
          statusCode: 402,
        };
      case 'http':
        throw {
          type:
            step.statusCode === 429
              ? 'StripeRateLimitError'
              : step.statusCode >= 500
                ? 'StripeAPIError'
                : 'StripeInvalidRequestError',
          statusCode: step.statusCode,
          requestId: step.requestId ?? 'req_fake',
          ...(step.code && { code: step.code }),
        };
      case 'timeout':
        if (step.applied) healthy();
        this.clock.advance(timeoutMs ?? 0);
        throw {
          type: 'StripeConnectionError',
          message: 'Request aborted due to timeout',
        };
      case 'connect_refused':
        throw {
          type: 'StripeConnectionError',
          message: 'connect ECONNREFUSED',
          detail: { code: 'ECONNREFUSED' },
        };
      case 'hang':
        await step.gate.wait();
        return healthy();
      case 'slow':
        this.clock.advance(step.ms);
        return healthy();
    }
  }
}

export interface Gate {
  /** Resolves when the first caller arrives at `wait()`. */
  reached: Promise<void>;
  open(): void;
  wait(): Promise<void>;
}

/** A latch: callers of `wait()` block until `open()`; `reached` resolves when the first caller arrives. */
export function createGate(): Gate {
  let release!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return {
    reached,
    open: () => release(),
    async wait() {
      reach();
      await opened;
    },
  };
}
