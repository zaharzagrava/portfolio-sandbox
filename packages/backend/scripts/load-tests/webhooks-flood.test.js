// S43 - webhook delivery under an event flood: 500,000 endpoints, 10% of the receivers slow, 5,000 deliveries a second.
// Ops artifact for SC-001, SC-002 (at scale) and SC-011 (specs/UNVERIFIED.md, status "not run"; never described as
// verified). The automated suite proves one delivery (AS-35) and 20 events on two endpoints (AS-37), not the load.
//
//   1. Start a receiver that answers `200` at once for healthy endpoints and hangs for SLOW_PERCENT of them, records
//      the time each POST arrives, and serves the arrival log on `GET $RECEIVER_STATS_URL` as
//      `{"delivered": n, "latencyMs": {"p95": x, "p99": y}, "healthyLatencyMs": {"p99": z}}`
//      (latency = arrival minus the `timestamp` of the event in the body).
//   2. Seed 500,000 endpoints on a production-sized stack: `INSERT INTO "WebhookEndpoint"` rows (and the
//      `WebhookShopCounter` rows, at most 20 per shop) whose `url` points at the receiver (`/ok/<n>` for 90%,
//      `/slow/<n>` for 10%), all subscribed to `product.updated`, with sealed secrets made by the application.
//   3. Flood the source: sellers PATCH products (`catalog.product_updated` reaches the router) at RATE a second:
//        k6 run -e BASE_URL=https://api.stack.example -e RECEIVER_STATS_URL=https://receiver.example/stats \
//          -e SELLERS=sellers.json -e RATE=500 scripts/load-tests/webhooks-flood.test.js
//      `sellers.json` is `[{"token": "...", "shopId": "...", "productId": "..."}, ...]`; one product update fans out to
//      the shop's endpoints, so size the shop/endpoint distribution to reach 5,000 deliveries a second.
//
// SLO read at the end (teardown): SC-001 95% of events reach a healthy endpoint within 5 s; SC-002 healthy endpoints
// keep p99 under 2 s while the slow ones hang; SC-011 sustained 5,000 deliveries a second (read
// `webhook_delivery_attempts_total` rate from /metrics, and `webhook_routing_lag_seconds`).
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const RECEIVER_STATS_URL = __ENV.RECEIVER_STATS_URL || '';
const RATE = Number(__ENV.RATE || 500);
const sellers = new SharedArray('sellers', () => JSON.parse(open(__ENV.SELLERS || './data/webhooks-sellers.json')));

const accepted = new Counter('webhook_flood_source_updates_accepted');
const deliveredMs = new Trend('webhook_flood_receiver_latency_ms');

export const options = {
  scenarios: {
    flood: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '10m',
      preAllocatedVUs: Math.min(RATE, 1000),
      maxVUs: Math.min(RATE * 2, 5000),
    },
  },
  thresholds: {
    'http_req_failed{name:PATCH product}': ['rate<0.01'],
    webhook_flood_receiver_latency_ms: ['p(95)<5000'],
  },
};

export default function () {
  const s = sellers[exec.scenario.iterationInTest % sellers.length];
  const res = http.patch(
    `${BASE_URL}/api/shops/${s.shopId}/products/${s.productId}`,
    JSON.stringify({ title: `flood ${exec.scenario.iterationInTest}` }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
      tags: { name: 'PATCH product' },
    },
  );
  if (check(res, { 'update accepted': (r) => r.status === 200 })) accepted.add(1);
}

export function teardown() {
  if (!RECEIVER_STATS_URL) return;
  const stats = http.get(RECEIVER_STATS_URL).json();
  if (stats && stats.latencyMs) deliveredMs.add(stats.latencyMs.p95);
  console.log(`receiver: ${JSON.stringify(stats)}`);
}
