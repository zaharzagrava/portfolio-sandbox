// SD-19 / S11 - flash sale: thousands of buyers check out the same drop at once.
//
//   node scripts/load-tests/seed/index.js payment       (seeded buyers)
//   k6 run -e PROFILE=load -e SELLER_EMAIL=<owner> -e SHOP_ID=<uuid> -e PRODUCT_ID=<uuid> \
//          scripts/load-tests/flash-sale.test.js
//
// setup() schedules the drop through the seller route (`POST /api/shops/:shopId/flash-sales`, start in 3 minutes, so
// `flash-sale.load` runs at start - 60 s on the worker) and waits until the public view says `LIVE`. Each VU then logs in,
// adds the product to its cart and checks out with a unique Idempotency-Key (plus one deliberate retry with the SAME key,
// which must return the same order). A refusal is `422 out_of_stock`, `429 flash_sale_busy` or `503 flash_sale_unavailable`.
//
// Pass criteria (thresholds, SC-002 and SC-001):
//   accepted checkouts   p99 < 150 ms        refusals   p99 < 50 ms
//   flash_oversold == 0  -- orders held or paid never exceed the units of the drop (computed in teardown from the
//                           seller's read of the sale: unitsHeld + unitsSold - units)
// Run at 1/2/4 API instances to check that throughput scales and oversells stay 0. The result of a run belongs in
// specs/UNVERIFIED.md (S11 SC-002); this script is not run by the automated suite.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import { urls, PASSWORD, buildScenario } from './lib/config.js';
import { uuidv7 } from './lib/utils.js';

const users = new SharedArray('buyers', () =>
  JSON.parse(open('./data/payment.json')).users.map((u) => u.email),
);
const SELLER_EMAIL = __ENV.SELLER_EMAIL;
const SHOP_ID = __ENV.SHOP_ID;
const PRODUCT_ID = __ENV.PRODUCT_ID;
const UNITS = Number(__ENV.UNITS || 3000);

const reserved = new Counter('flash_orders_reserved');
const soldOut = new Counter('flash_sold_out');
const busy = new Counter('flash_busy');
const unavailable = new Counter('flash_unavailable');
const idempotencyViolations = new Counter('flash_idempotency_violations');
const oversold = new Counter('flash_oversold');
const acceptedMs = new Trend('flash_accepted_ms', true);
const refusedMs = new Trend('flash_refused_ms', true);

export const options = {
  scenarios: {
    drop: buildScenario(users.length, {
      smoke: { vus: 10, iterations: 50, maxDuration: '5m' },
      load: { vus: 2000, iterations: 20000, maxDuration: '10m' },
      stress: { vus: 10000, iterations: 100000, maxDuration: '20m' },
    }),
  },
  thresholds: {
    flash_accepted_ms: ['p(99)<150'],
    flash_refused_ms: ['p(99)<50'],
    'http_req_duration{name:PUT /api/cart/items}': ['p(99)<50'],
    flash_idempotency_violations: ['count==0'],
    flash_oversold: ['count==0'],
  },
};

const json = { 'Content-Type': 'application/json' };

function login(email) {
  const res = http.post(
    `${urls.api}/api/auth/login`,
    JSON.stringify({ email, password: PASSWORD }),
    {
      headers: json,
      tags: { name: 'POST /api/auth/login' },
    },
  );
  return res.status === 200
    ? { ...json, Authorization: `Bearer ${res.json('accessToken.token')}` }
    : null;
}

export function setup() {
  const seller = login(SELLER_EMAIL);
  if (!seller) throw new Error('seller login failed');
  const startsAt = new Date(Date.now() + 3 * 60_000);
  const created = http.post(
    `${urls.api}/api/shops/${SHOP_ID}/flash-sales`,
    JSON.stringify({
      productId: PRODUCT_ID,
      priceMinor: 49_900,
      units: UNITS,
      buckets: 16,
      perUserLimit: 1,
      admissionRatePerSecond: 2000,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
    }),
    { headers: seller },
  );
  if (created.status !== 201)
    throw new Error(`sale not created: ${created.status} ${created.body}`);
  const saleId = created.json('id');
  // wait for the start: the load job moves the sale to LOADED a minute earlier, the public view turns LIVE at the start
  for (let i = 0; i < 400; i += 1) {
    if (
      http.get(`${urls.api}/api/flash-sales/${saleId}`).json('state') === 'LIVE'
    )
      return { saleId };
    sleep(1);
  }
  throw new Error(`sale ${saleId} did not become LIVE`);
}

export default function (data) {
  const auth = login(users[__ITER % users.length]);
  if (!auth) return;

  http.put(
    `${urls.api}/api/cart/items/${PRODUCT_ID}`,
    JSON.stringify({ quantity: 1 }),
    {
      headers: auth,
      tags: { name: 'PUT /api/cart/items' },
    },
  );

  const key = uuidv7();
  const first = http.post(`${urls.api}/api/checkout`, null, {
    headers: { ...auth, 'Idempotency-Key': key },
    tags: { name: 'POST /api/checkout' },
  });
  if (first.status === 202) {
    reserved.add(1);
    acceptedMs.add(first.timings.duration);
    const retry = http.post(`${urls.api}/api/checkout`, null, {
      headers: { ...auth, 'Idempotency-Key': key },
      tags: { name: 'POST /api/checkout (retry)' },
    });
    if (retry.json('orderId') !== first.json('orderId'))
      idempotencyViolations.add(1);
  } else {
    refusedMs.add(first.timings.duration);
    if (first.status === 422) soldOut.add(1);
    else if (first.status === 429) busy.add(1);
    else if (first.status === 503) unavailable.add(1);
  }
  check(first, {
    'reserved, sold out, busy or unavailable': (r) =>
      [202, 422, 429, 503].includes(r.status),
  });
  return data;
}

export function teardown(data) {
  const seller = login(SELLER_EMAIL);
  const sale = http.get(
    `${urls.api}/api/shops/${SHOP_ID}/flash-sales/${data.saleId}`,
    { headers: seller },
  );
  if (sale.status !== 200) return;
  const stats = sale.json('stats');
  const units = sale.json('units');
  // orders that hold or have bought units must never exceed the drop (the invariant of SC-001)
  if (stats)
    oversold.add(Math.max(0, stats.unitsHeld + stats.unitsSold - units));
}
