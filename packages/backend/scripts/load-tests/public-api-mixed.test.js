// S42 SC-010 - seller public API: a mixed read/write/batch load across many keys and several instances.
//
//   k6 run -e PROFILE=load -e PUBLIC_API_URL=http://<lb> -e KEYS_FILE=keys.json \
//          scripts/load-tests/public-api-mixed.test.js
//
// `keys.json` is `["sk_test_…", …]` (test keys of sandbox shops, so no usage is billed): create them through
// `POST /api/shops/:shopId/developers/keys` for as many shops as the run needs (100,000 keys for the full goal).
// Each iteration picks a key and makes one call: 45 % `GET /v1/products` (20 rows), 40 % `GET /v1/orders`, 13 % a one-row
// product read, 2 % a `POST /v1/batch` of 10 reads, so reads dominate as they do for ERP integrations.
//
// Pass criteria (thresholds, SC-010):
//   authenticated reads   p99 < 150 ms
//   5xx answers           none (a `429` is a limit working, counted apart; a limiter outage must not become a 5xx)
//   every response carries `Request-Id` (logging and metering add no latency, and never drop the id)
// Run against 3 or more `public-api` instances behind one address to check that the per-key limit holds across them.
// The result of a run belongs in specs/UNVERIFIED.md (S42 SC-010); this script is not run by the automated suite.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import { PROFILE } from './lib/config.js';

const BASE = __ENV.PUBLIC_API_URL || 'http://localhost:8001';
const keys = new SharedArray('keys', () => JSON.parse(open(__ENV.KEYS_FILE || './data/public-api-keys.json')));

const readMs = new Trend('public_api_read_ms', true);
const limited = new Counter('public_api_limited');
const serverErrors = new Counter('public_api_server_errors');
const missingRequestId = new Rate('public_api_missing_request_id');

const PROFILES = {
  smoke: { rate: 50, duration: '30s', preAllocatedVUs: 20, maxVUs: 100 },
  load: { rate: 5000, duration: '10m', preAllocatedVUs: 1000, maxVUs: 5000 },
  // the goal of SC-010: 30,000 requests per second in total (spread over load generators)
  stress: { rate: 30000, duration: '10m', preAllocatedVUs: 5000, maxVUs: 20000 },
};

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate',
      timeUnit: '1s',
      ...(PROFILES[PROFILE] || PROFILES.smoke),
    },
  },
  thresholds: {
    public_api_read_ms: ['p(99)<150'],
    public_api_server_errors: ['count==0'],
    public_api_missing_request_id: ['rate==0'],
  },
};

function call(method, path, key, body) {
  const headers = { Authorization: `Bearer ${key}` };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = `${__VU}-${__ITER}-${Date.now()}`;
  }
  return http.request(method, `${BASE}${path}`, body ? JSON.stringify(body) : null, {
    headers,
    tags: { name: `${method} ${path.split('?')[0]}` },
  });
}

function observe(res, isRead) {
  if (isRead) readMs.add(res.timings.duration);
  if (res.status === 429) limited.add(1);
  if (res.status >= 500) serverErrors.add(1);
  missingRequestId.add(!res.headers['Request-Id']);
  check(res, { 'answered 2xx or 429': (r) => (r.status >= 200 && r.status < 300) || r.status === 429 });
}

export default function () {
  const key = keys[Math.floor(Math.random() * keys.length)];
  const pick = Math.random();
  if (pick < 0.45) return observe(call('GET', '/v1/products?limit=20', key), true);
  if (pick < 0.85) return observe(call('GET', '/v1/orders?limit=20', key), true);
  if (pick < 0.98) return observe(call('GET', '/v1/products?limit=1', key), true);
  const operations = Array.from({ length: 10 }, () => ({ method: 'GET', path: '/v1/products?limit=1' }));
  return observe(call('POST', '/v1/batch', key, { operations }), false);
}
