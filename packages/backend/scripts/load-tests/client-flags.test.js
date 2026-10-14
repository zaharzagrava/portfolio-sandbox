// SD-38 / S38 - the pre-evaluated client flags endpoint: `GET /api/flags` at 500 client-side flags.
//
//   1. Start the core with the load-test profile (`pnpm start:load-test`) so the per-IP limit of 120 a minute is lifted
//      for the run (or run from many addresses); a limited answer (429) fails the run on purpose.
//   2. Seed 500 client-side flags straight into the table (the admin API allows 30 writes a minute):
//        psql "$DATABASE_URL" -c "INSERT INTO \"FeatureFlag\" (\"key\",\"status\",\"enabled\",\"variants\",\"defaultVariant\",
//          \"offVariant\",\"rules\",\"bucketBy\",\"clientSide\",\"owner\",\"version\")
//          SELECT 'load-' || lpad(i::text, 3, '0'), 'enabled', true, '[{\"key\":\"off\",\"value\":false},{\"key\":\"on\",\"value\":true}]',
//          'off', 'off', '[{\"id\":\"half\",\"conditions\":[],\"rollout\":[{\"variant\":\"on\",\"weight\":5000},{\"variant\":\"off\",\"weight\":5000}]}]',
//          'userId', true, 'load-team', 1 FROM generate_series(1, 500) i ON CONFLICT DO NOTHING"
//      then restart the core (or wait one poll, 35 s) so its SDK holds the 500 flags.
//   3. k6 run -e BASE_URL=http://localhost:8000 scripts/load-tests/client-flags.test.js
//
// SLO (S38 SC-008): p99 under 50 ms at 500 flags, with 0 rules and 0 non-client flags in the body. This is an ops
// artifact (specs/UNVERIFIED.md): the automated suite proves what the body contains (AS-37), not the latency.
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const RATE = Number(__ENV.RATE || 500);
const leaked = new Rate('client_flags_leaked_rules');

export const options = {
  scenarios: {
    visitors: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: Math.min(RATE, 500),
      maxVUs: Math.min(RATE * 2, 2000),
    },
  },
  thresholds: {
    'http_req_duration{name:GET /api/flags}': ['p(99)<50'],
    'http_req_failed{name:GET /api/flags}': ['rate<0.001'],
    client_flags_leaked_rules: ['rate==0'],
  },
};

export default function () {
  const anonymousId = `load-visitor-${__VU}-${__ITER}`;
  const res = http.get(`${BASE_URL}/api/flags`, {
    headers: { 'X-Anonymous-Id': anonymousId },
    tags: { name: 'GET /api/flags' },
  });
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'private no-store': (r) => r.headers['Cache-Control'] === 'private, no-store',
  });
  if (ok) leaked.add(/"rules"|"rollout"|"owner"/.test(res.body));
}
