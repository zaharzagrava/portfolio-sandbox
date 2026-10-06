// Flow 1 - buyers log in and pay through the Cloudflare edge.
//
//   node scripts/load-tests/seed/index.js payment
//   k6 run -e PROFILE=load scripts/load-tests/payment.test.js
//
// POST /api/payments on the edge only *accepts* the command (202 -> Kafka).
// A sample of payments is then polled until payment-processor (NestJS or the
// Go port in packages/payments) settles it, which gives `payment_settle_time`
// - the number to compare between the two implementations.
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import { PASSWORD, baseThresholds, buildScenario, urls } from './lib/config.js';
import { authHeaders, login, safeJson } from './lib/auth.js';
import { randomBetween, randomInt, uuidv7 } from './lib/utils.js';
import { summaryFor } from './lib/summary.js';

const users = new SharedArray('payment users', () => JSON.parse(open('./data/payment.json')).users);

const PAYMENTS_PER_USER = Number(__ENV.PAYMENTS_PER_USER || 3);
// Fraction of accepted payments polled to settlement (polling every payment
// would mostly load-test the read path instead of the processor).
const TRACK_RATE = Number(__ENV.TRACK_RATE || 0.1);
const POLL_INTERVAL_S = Number(__ENV.POLL_INTERVAL_S || 0.25);
const SETTLE_TIMEOUT_MS = Number(__ENV.SETTLE_TIMEOUT_MS || 30000);

const paymentsAccepted = new Counter('payments_accepted');
const paymentsRejected = new Counter('payments_rejected');
const paymentsSettled = new Counter('payments_settled');
const paymentsSettleTimeouts = new Counter('payments_settle_timeouts');
const settleTime = new Trend('payment_settle_time', true);

export const options = {
  scenarios: {
    payment: buildScenario(users.length, {
      smoke: { vus: 5, iterations: 20, maxDuration: '3m' },
      load: { vus: 500, maxDuration: '45m' },
      stress: { vus: 2000, maxDuration: '45m' },
    }),
  },
  thresholds: {
    ...baseThresholds,
    'http_req_duration{name:POST edge /api/payments}': ['p(95)<500'],
    'http_req_failed{name:POST edge /api/payments}': ['rate<0.01'],
    payment_settle_time: ['p(95)<5000'],
    payments_settle_timeouts: ['count<1'],
  },
};

export default function () {
  const user = users[exec.scenario.iterationInTest % users.length];

  const session = login(user.email, PASSWORD);
  if (!session) return;

  for (let i = 0; i < PAYMENTS_PER_USER; i++) {
    const idempotencyKey = uuidv7();

    const res = http.post(
      `${urls.edge}/api/payments`,
      JSON.stringify({
        idempotency_key: idempotencyKey,
        // >= 50: the ledger books a fixed 50-cent platform fee
        amount: randomInt(100, 20000),
        bisOrderId: user.bisOrderId,
        paymentMethodId: 'pm_card_visa',
      }),
      {
        headers: authHeaders(session.token, { 'Content-Type': 'application/json' }),
        tags: { name: 'POST edge /api/payments' },
      },
    );

    const accepted = check(res, {
      'payment: status 202': (r) => r.status === 202,
      'payment: echoes idempotency key': (r) => safeJson(r, 'idempotencyKey') === idempotencyKey,
    });

    if (!accepted) {
      paymentsRejected.add(1, { status: String(res.status) });
    } else {
      paymentsAccepted.add(1);
      if (Math.random() < TRACK_RATE) awaitSettlement(idempotencyKey, session.token);
    }

    sleep(randomBetween(0.5, 1.5));
  }
}

function awaitSettlement(idempotencyKey, token) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < SETTLE_TIMEOUT_MS) {
    sleep(POLL_INTERVAL_S);

    const res = http.get(`${urls.api}/api/payment/by-key/${idempotencyKey}`, {
      headers: authHeaders(token),
      tags: { name: 'GET /api/payment/by-key/:key' },
      // 404 = processor hasn't consumed the event yet; not a failure
      responseCallback: http.expectedStatuses(200, 404),
    });

    if (res.status === 200) {
      const status = safeJson(res, 'status');
      if (status && status !== 'PENDING') {
        settleTime.add(Date.now() - startedAt);
        paymentsSettled.add(1, { status });
        return;
      }
    } else if (res.status !== 404) {
      break;
    }
  }

  paymentsSettleTimeouts.add(1);
}

export const handleSummary = summaryFor('payment');
