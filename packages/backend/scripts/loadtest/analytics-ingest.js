// SD-31 / S39 - the ingest fallback under load: `POST /api/events` with 50-event batches.
//
//   1. Start the core with the load-test profile (`pnpm start:load-test`) so the per-address limit of 120 requests a minute
//      is lifted for the run, or spread the run over many addresses (the script sends a distinct `X-Forwarded-For` per
//      virtual user when the core trusts the load generator as a proxy: TRUSTED_PROXIES=<generator address>). A limited
//      answer (429) fails the run on purpose.
//   2. k6 run -e BASE_URL=http://localhost:8000 scripts/loadtest/analytics-ingest.js
//      (`pnpm loadtest:analytics-ingest`; BATCHES_PER_S=40 is 2,000 events/s, DURATION=10m is the criterion's length).
//   3. Afterwards compare the number of distinct accepted event ids with `count(DISTINCT event_id)` in
//      `analytics_event_log` and read the consumer lag of group `clickhouse-analytics` (it must stay under 10 s).
//
// SLO (S39 SC-001): p99 under 200 ms per 50-event batch at the fallback, zero accepted events missing from the store,
// consumer lag under 10 s. The edge (`wrangler dev`, POST /collect, p99 under 50 ms) is a separate run of this script with
// `-e BASE_URL=<worker> -e PATH=/collect`. This is an ops artifact (specs/UNVERIFIED.md): the automated suite proves what
// is accepted and stored (AS-01 – AS-16), not the latency or the sustained rate.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const PATH = __ENV.PATH || '/api/events';
const BATCHES_PER_S = Number(__ENV.BATCHES_PER_S || 40);
const accepted = new Counter('analytics_events_accepted');
const rejected = new Counter('analytics_events_rejected');

export const options = {
  scenarios: {
    collectors: {
      executor: 'constant-arrival-rate',
      rate: BATCHES_PER_S,
      timeUnit: '1s',
      duration: __ENV.DURATION || '10m',
      preAllocatedVUs: 100,
      maxVUs: 1000,
    },
  },
  thresholds: {
    'http_req_duration{name:POST events}': ['p(99)<200'],
    'http_req_failed{name:POST events}': ['rate<0.001'],
    analytics_events_rejected: ['count==0'],
  },
};

const hex = (n) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const uuid = () =>
  `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;

export default function () {
  const anonymousId = `load-visitor-${__VU}-${hex(8)}`;
  const now = Date.now();
  const events = Array.from({ length: 50 }, (_, i) => ({
    event_id: uuid(),
    name: i % 5 === 0 ? 'product_view' : 'page_view',
    anonymous_id: anonymousId,
    ts: now - i,
    page: '/products/load',
    props: { product_id: '5d7d1b2e-2a53-4d5e-9d5c-1f2f3a4b5c6d', category: 'audio' },
  }));
  const res = http.post(`${BASE_URL}${PATH}`, JSON.stringify({ events }), {
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `10.${__VU % 250}.${(__ITER >> 8) % 250}.${__ITER % 250}`,
    },
    tags: { name: 'POST events' },
  });
  const ok = check(res, { 'status 202': (r) => r.status === 202 });
  if (ok) {
    const body = res.json();
    accepted.add(body.accepted);
    rejected.add(body.rejected.length);
  }
}
