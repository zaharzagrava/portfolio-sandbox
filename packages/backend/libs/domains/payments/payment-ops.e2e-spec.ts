import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { context, trace } from '@opentelemetry/api';
import { ApiConfigService } from '@app/common/config';
import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { installTestTracing } from '@app/infrastructure/events/testing/test-tracing';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { PaymentIntentService } from './application/payment-intent.service';
import { ChargeCommandWorker } from './infra/charge-command.worker';
import { RefundRequestWorker } from './infra/refund-request.worker';
import { createGate } from './testing/fake-payment-provider';
import {
  acceptPayment,
  createPaymentsApp,
  deliverCharge,
  outboxRows,
  paymentRow,
  payableBuyer,
  type PaymentsTestApp,
} from './testing';

const SECOND = 1_000;
const SENTINEL_METHOD = 'pm_SENTINEL_card_9f3c71';
const SENTINEL_SECRET = 'pi_SENTINEL_secret_41d2e8';

/** The settings of payments that must be positive integers (config key → environment variable). */
const LIMIT_SETTINGS: Array<[string, string]> = [
  ['payments_create_timeout_ms', 'PAYMENTS_CREATE_TIMEOUT_MS'],
  ['payments_lookup_timeout_ms', 'PAYMENTS_LOOKUP_TIMEOUT_MS'],
  ['payments_breaker_window_ms', 'PAYMENTS_BREAKER_WINDOW_MS'],
  ['payments_breaker_min_calls', 'PAYMENTS_BREAKER_MIN_CALLS'],
  ['payments_breaker_open_ms', 'PAYMENTS_BREAKER_OPEN_MS'],
  ['payments_charge_max_attempts', 'PAYMENTS_CHARGE_MAX_ATTEMPTS'],
  ['payments_charge_deadline_seconds', 'PAYMENTS_CHARGE_DEADLINE_SECONDS'],
  ['payments_resolve_no_record_seconds', 'PAYMENTS_RESOLVE_NO_RECORD_SECONDS'],
  ['payments_stuck_seconds', 'PAYMENTS_STUCK_SECONDS'],
  ['payments_sweep_batch', 'PAYMENTS_SWEEP_BATCH'],
  ['payments_refund_window_seconds', 'PAYMENTS_REFUND_WINDOW_SECONDS'],
  ['payments_page_max', 'PAYMENTS_PAGE_MAX'],
];

describe('Payments: observability, secrets, configuration and shutdown', () => {
  let t: PaymentsTestApp;

  beforeAll(async () => {
    t = await createPaymentsApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());
  afterEach(() => jest.restoreAllMocks());

  const counter = (name: string, labels: Record<string, string> = {}) =>
    MetricsRegistry.value(name, labels) ?? 0;

  /** Everything the process logs through the Nest logger while `work` runs. */
  const captureLogs = async (work: () => Promise<void>): Promise<string> => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation(
          (...args: unknown[]) => void lines.push(JSON.stringify(args)),
        );
    await work();
    return lines.join('\n');
  };

  describe('metrics and logs (AS-62)', () => {
    it('S13 AS-62: the instruments of the charge, decline, unknown, breaker and refund flows move as described and carry only bounded labels', async () => {
      const created = counter('payments_created_total', { result: 'accepted' });
      const toCompleted = counter('payments_status_transitions_total', {
        from: 'PENDING',
        to: 'COMPLETED',
      });
      const succeeded = counter('payments_provider_calls_total', {
        operation: 'create_intent',
        outcome: 'succeeded',
      });
      const declined = counter('payments_provider_calls_total', {
        operation: 'create_intent',
        outcome: 'declined',
      });
      const unknown = counter('payments_unknown_outcomes_total');
      const refunds = counter('payments_refund_requests_total', {
        result: 'accepted',
      });

      // AS-15: a charge that succeeds
      const paid = await payableBuyer(t);
      const paidId = await acceptPayment(t, paid);
      await deliverCharge(t, paidId);
      const row = (await paymentRow(t.app, paidId))!;
      expect(row.status).toBe('COMPLETED');
      expect(counter('payments_created_total', { result: 'accepted' })).toBe(
        created + 1,
      );
      expect(
        counter('payments_status_transitions_total', {
          from: 'PENDING',
          to: 'COMPLETED',
        }),
      ).toBe(toCompleted + 1);
      expect(
        counter('payments_provider_calls_total', {
          operation: 'create_intent',
          outcome: 'succeeded',
        }),
      ).toBe(succeeded + 1);

      // AS-16: a decline
      t.provider.script('create', {
        kind: 'card_error',
        code: 'card_declined',
      });
      await deliverCharge(t, await acceptPayment(t, await payableBuyer(t)));
      expect(
        counter('payments_provider_calls_total', {
          operation: 'create_intent',
          outcome: 'declined',
        }),
      ).toBe(declined + 1);

      // AS-23: a silent provider
      t.provider.script('create', { kind: 'timeout' });
      await deliverCharge(t, await acceptPayment(t, await payableBuyer(t)));
      expect(counter('payments_unknown_outcomes_total')).toBe(unknown + 1);

      // AS-31: ten 503s open the create breaker
      t.provider.scriptRepeat('create', { kind: 'http', statusCode: 503 }, 10);
      for (let i = 0; i < 10; i++)
        await deliverCharge(t, await acceptPayment(t, await payableBuyer(t)));
      expect(
        MetricsRegistry.value('circuit_breaker_open', {
          breaker: 'create_intent',
        }),
      ).toBe(1);

      // AS-50: a refund request for the completed payment
      await t.app.get(RefundRequestWorker, { strict: false }).handle({
        body: {
          orderId: paid.order.orderId,
          paymentRef: row.providerRef,
          amountMinor: paid.order.totalMinor,
          currency: 'EUR',
          reason: 'order_cancelled',
        },
      });
      expect(
        counter('payments_refund_requests_total', { result: 'accepted' }),
      ).toBe(refunds + 1);
      expect(
        counter('payments_status_transitions_total', {
          from: 'COMPLETED',
          to: 'REFUND_PENDING',
        }),
      ).toBeGreaterThanOrEqual(1);

      // never an identifier as a label (the registry refuses user, shop and request ids; payments adds its own two)
      const allowed = new Set([
        'result',
        'from',
        'to',
        'operation',
        'outcome',
        'breaker',
        'reason',
        'field',
        'overflow',
      ]);
      for (const name of [
        'payments_created_total',
        'payments_status_transitions_total',
        'payments_provider_calls_total',
        'payments_unknown_outcomes_total',
        'circuit_breaker_open',
        'payments_refund_requests_total',
      ])
        for (const labels of MetricsRegistry.labelSets(name))
          for (const key of Object.keys(labels))
            expect([name, allowed.has(key)]).toEqual([name, true]);
    });

    it('S13 AS-62: a failing charge is logged with the payment id and the order id, and the metrics registry never sees either', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      t.provider.script('create', {
        kind: 'http',
        statusCode: 400,
        requestId: 'req_provider_77',
      });

      const logs = await captureLogs(() => deliverCharge(t, id));

      expect(logs).toContain(id);
      expect(logs).toContain(buyer.order.orderId);
      expect(logs).toContain('req_provider_77');
      for (const name of ['payments_provider_calls_total'])
        for (const labels of MetricsRegistry.labelSets(name))
          expect(JSON.stringify(labels)).not.toMatch(
            new RegExp(`${id}|${buyer.order.orderId}`),
          );
    });

    it('S13 AS-62: the trace of the accept request continues in the outbox row the processor will consume', async () => {
      const tracing = installTestTracing();
      try {
        const buyer = await payableBuyer(t);
        const traceId = await tracing.tracer.startActiveSpan(
          'accept',
          async (span) => {
            try {
              await t.app
                .get(PaymentIntentService, { strict: false })
                .accept(buyer.user.id, {
                  orderId: buyer.order.orderId,
                  paymentMethodId: 'pm_card_visa',
                });
              return trace.getSpan(context.active())!.spanContext().traceId;
            } finally {
              span.end();
            }
          },
        );
        const command = (await outboxRows(t.app, 'payments.charge_requested'))
          .map((r) => r.payload as { traceparent?: string })
          .find((p) => p.traceparent?.includes(traceId));
        expect(command?.traceparent).toMatch(
          new RegExp(`^00-${traceId}-[0-9a-f]{16}-0[01]$`),
        );
      } finally {
        await tracing.shutdown();
      }
    });
  });

  describe('secrets and card data (AS-63)', () => {
    it('S13 AS-63: the payment method, the provider secret and the customer-action secret appear in no log, outbox row, event, push or error body', async () => {
      const config = t.app.get(ApiConfigService);
      const providerKey = config.get('stripe_secret_key') as string;
      const bodies: string[] = [];
      const logs = await captureLogs(async () => {
        // a paid order
        const paid = await payableBuyer(t);
        const paidId = await acceptPayment(t, paid, SENTINEL_METHOD);
        await deliverCharge(t, paidId);
        bodies.push(
          JSON.stringify(
            (await t.as(paid.user).get(`/api/payments/${paidId}`)).body,
          ),
          JSON.stringify((await t.as(paid.user).get('/api/payments')).body),
        );

        // a decline and a rejected request
        for (const step of [
          { kind: 'card_error', code: 'card_declined' } as const,
          { kind: 'http', statusCode: 401 } as const,
        ]) {
          const buyer = await payableBuyer(t);
          const id = await acceptPayment(t, buyer, SENTINEL_METHOD);
          t.provider.script('create', step);
          await deliverCharge(t, id);
        }

        // customer action: the secret is only for the owner's read
        const action = await payableBuyer(t);
        const actionId = await acceptPayment(t, action, SENTINEL_METHOD);
        t.provider.script('create', {
          kind: 'ok',
          status: 'requires_action',
          overrides: { client_secret: SENTINEL_SECRET },
        });
        await deliverCharge(t, actionId);
        const stranger = await t.newUser();
        bodies.push(
          JSON.stringify(
            (await t.as(stranger).get(`/api/payments/${actionId}`)).body,
          ),
          JSON.stringify((await t.as(stranger).get('/api/payments')).body),
          JSON.stringify((await t.as(action.user).get('/api/payments')).body),
        );

        // a bad body and an unexpected failure (5xx): generic answers
        const rejected = await t
          .as(paid.user)
          .post('/api/payments/intents')
          .set('Idempotency-Key', `key-${randomUUID()}`)
          .send({ orderId: 'nope', paymentMethodId: SENTINEL_METHOD });
        expect(rejected.status).toBe(400);
        bodies.push(JSON.stringify(rejected.body));

        t.patch(
          t.app.get(PaymentIntentService, { strict: false }),
          'accept',
          () => async () => {
            throw new Error('boom: select * from "Payment" failed');
          },
        );
        const failing = await payableBuyer(t);
        const crashed = await t
          .as(failing.user)
          .post('/api/payments/intents')
          .set('Idempotency-Key', `key-${randomUUID()}`)
          .send({
            orderId: failing.order.orderId,
            paymentMethodId: SENTINEL_METHOD,
          });
        expect(crashed.status).toBe(500);
        expect(JSON.stringify(crashed.body)).not.toMatch(
          /boom|select|Payment"/i,
        );
        bodies.push(JSON.stringify(crashed.body));
      });

      const outbox = JSON.stringify(await outboxRows(t.app));
      const pushes = JSON.stringify(t.realtime.published);
      const sinks = { logs, outbox, pushes, bodies: bodies.join('\n') };
      for (const [name, text] of Object.entries(sinks))
        for (const secret of [SENTINEL_METHOD, SENTINEL_SECRET, providerKey])
          expect([name, text.includes(secret)]).toEqual([name, false]);
    });
  });

  describe('configuration (AS-65)', () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    });
    const boot = () => new ApiConfigService(new ConfigUtilsService()).init();

    it('S13 AS-65: without the provider key the process does not start, and the error names the setting but shows no value', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      await expect(boot()).rejects.toThrow(/stripe_secret_key/);
    });

    it.each(LIMIT_SETTINGS)(
      'S13 AS-65: %s set to zero or below fails startup naming the setting',
      async (key, variable) => {
        for (const bad of ['0', '-5', 'abc']) {
          process.env[variable] = bad;
          const failure = await boot().then(
            () => null,
            (error: Error) => error,
          );
          expect([variable, bad, failure?.message ?? '']).toEqual([
            variable,
            bad,
            expect.stringContaining(key),
          ]);
          expect(failure?.message).not.toContain(` ${bad}`);
        }
      },
    );

    it('S13 AS-65: the defaults of contracts/services.md apply when nothing is set', async () => {
      for (const [, variable] of LIMIT_SETTINGS) delete process.env[variable];
      const config = new ApiConfigService(new ConfigUtilsService());
      await config.init();
      expect(config.get('payments_create_timeout_ms')).toBe(8_000);
      expect(config.get('payments_lookup_timeout_ms')).toBe(4_000);
      expect(config.get('payments_breaker_open_ms')).toBe(30_000);
      expect(config.get('payments_charge_max_attempts')).toBe(6);
      expect(config.get('payments_stuck_seconds')).toBe(86_400);
    });
  });

  describe('graceful shutdown (AS-66)', () => {
    it('S13 AS-66: on the stop signal no new command is taken, the call in flight finishes within 8 s and is recorded, then the tasks end clean', async () => {
      const registry = new ShutdownRegistry();
      const own = await createPaymentsApp({
        overrides: [{ provide: ShutdownRegistry, useValue: registry }],
      });
      try {
        await own.reset();
        const worker = own.app.get(ChargeCommandWorker, { strict: false });
        expect(registry.listTaskNames()).toEqual(
          expect.arrayContaining([
            'payments.charge-worker',
            'payments.refund-worker',
          ]),
        );

        const id = await acceptPayment(own, await payableBuyer(own));
        const later = await acceptPayment(own, await payableBuyer(own));
        const gate = createGate();
        own.provider.script('create', { kind: 'hang', gate });
        const inFlight = deliverCharge(own, id);
        await gate.reached;

        const started = Date.now();
        const stopping = registry.run('stop');
        await new Promise((r) => setTimeout(r, 50));

        // intake is closed: a command arriving now is refused (the queue redelivers it elsewhere); nothing reaches the provider
        const callsBefore = own.provider.count('create');
        await expect(
          worker.handle({ body: { paymentId: later, attempt: 0 } }),
        ).rejects.toThrow(/shutting down/);
        expect(own.provider.count('create')).toBe(callsBefore);

        // the call in flight is allowed to finish and is recorded
        gate.open();
        await inFlight;
        const outcome = await stopping;
        expect(outcome.failed).toEqual([]);
        expect(Date.now() - started).toBeLessThan(8 * SECOND);
        expect(await paymentRow(own.app, id)).toMatchObject({
          status: 'COMPLETED',
        });
        expect(await paymentRow(own.app, later)).toMatchObject({
          status: 'PENDING',
          chargeAttemptedAt: null,
        });
      } finally {
        await own.close();
      }
    });
  });
});
