// SD-19 - flash sale: thousands of buyers check out the same SKU at once.
//
//   node scripts/load-tests/seed/index.js payment       (seeded buyers)
//   # create a product with a flash sale (POST /api/shops/:shopId/flash-sales) starting now
//   k6 run -e PROFILE=load -e PRODUCT_ID=<uuid> scripts/load-tests/flash-sale.test.js
//
// Each VU logs in, adds the product to its DynamoDB cart, and checks out
// with a unique Idempotency-Key (plus one deliberate retry with the SAME key,
// which must return the same order). Thresholds encode the SD-19 SLOs; after
// the run, verify invariants with:
//   SELECT count(*) FROM "BisOrderItem" WHERE "flashSaleId" = '<saleId>'   -- must equal sold units, never more
// Run at 1/2/4 API instances to check that throughput scales and oversells stay 0.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { urls, PASSWORD, buildScenario } from './lib/config.js';
import { uuidv7 } from './lib/utils.js';

const users = new SharedArray('buyers', () => JSON.parse(open('./data/payment.json')).users.map((u) => u.email));
const PRODUCT_ID = __ENV.PRODUCT_ID;

const reserved = new Counter('flash_orders_reserved');
const soldOut = new Counter('flash_sold_out');
const idempotencyViolations = new Counter('flash_idempotency_violations');

export const options = {
  scenarios: {
    drop: buildScenario(users.length, {
      smoke: { vus: 10, iterations: 50, maxDuration: '5m' },
      load: { vus: 2000, iterations: 20000, maxDuration: '10m' },
      stress: { vus: 10000, iterations: 100000, maxDuration: '20m' },
    }),
  },
  thresholds: {
    'http_req_duration{name:POST /api/checkout}': ['p(99)<150'],
    'http_req_duration{name:PUT /api/cart/items}': ['p(99)<50'],
    flash_idempotency_violations: ['count==0'],
  },
};

export default function () {
  const email = users[__ITER % users.length];
  const login = http.post(`${urls.api}/api/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'POST /api/auth/login' },
  });
  if (login.status !== 200) return;
  const auth = { Authorization: `Bearer ${login.json('accessToken.token')}`, 'Content-Type': 'application/json' };

  http.put(`${urls.api}/api/cart/items/${PRODUCT_ID}`, JSON.stringify({ quantity: 1 }), { headers: auth, tags: { name: 'PUT /api/cart/items' } });

  const key = uuidv7();
  const first = http.post(`${urls.api}/api/checkout`, null, { headers: { ...auth, 'Idempotency-Key': key }, tags: { name: 'POST /api/checkout' } });
  if (first.status === 201) {
    reserved.add(1);
    const retry = http.post(`${urls.api}/api/checkout`, null, { headers: { ...auth, 'Idempotency-Key': key }, tags: { name: 'POST /api/checkout (retry)' } });
    if (retry.json('orderId') !== first.json('orderId')) idempotencyViolations.add(1);
  } else if (first.status === 422) {
    soldOut.add(1);
  }
  check(first, { 'reserved or sold out': (r) => r.status === 201 || r.status === 422 || r.status === 429 });
}
