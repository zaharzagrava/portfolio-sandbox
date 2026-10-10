// SD-28 / S50 - distributed rate limiter accuracy and overhead.
//
//   k6 run -e PROFILE=load -e INSTANCES=4 scripts/load-tests/ratelimit.test.js
//
// Hammers the token-bucket-limited search endpoint (`search.query`, 60/min per key, local lease) as a handful of
// "users" (anonymous → keyed by address, so the API must trust the load balancer: TRUSTED_PROXIES, and each VU group
// sends its own X-Forwarded-For) at ~2x the allowed rate. Run it against 1, 2 and 4 API instances behind a load
// balancer (-e INSTANCES=n labels the run): the number of 200s per key must stay ≈ the policy budget whatever the
// instance count (shared Redis state, SC-001), and p99 latency overhead must stay small (SC-002).
//
// Store-call ratio (SC-002, SC-005): the script cannot see the store, so read it from Redis around the run:
//   redis-cli INFO commandstats | grep cmdstat_evalsha     # before and after; (calls after - before) / requests sent
// on a hot key it must stay at or below 0.1.
//
// Contract checked on every response: a 429 carries `Retry-After` >= 1, `RateLimit-Policy` and `RateLimit` in the
// structured-field format (`"policy";q=60;w=60`, `"policy";r=0;t=12`) and `Cache-Control: no-store`; a 503
// (`rate_limiter_unavailable`, store down on a fail-closed policy) carries `Retry-After: 1`. Stop Redis mid-run to
// exercise the 503 path of a fail-closed route and the fail-open path of this one (SC-003).
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { urls } from './lib/config.js';

const allowed = new Counter('ratelimit_allowed');
const limited = new Counter('ratelimit_limited');
const unavailable = new Counter('ratelimit_unavailable');
const POLICY_ITEM = /^"[a-z0-9.-]+";q=\d+;w=\d+$/;
const LIMIT_ITEM = /^"[a-z0-9.-]+";r=\d+;t=\d+$/;

export const options = {
  tags: { instances: String(__ENV.INSTANCES || 'unspecified') },
  scenarios: {
    burst: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 200),
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: 50,
    },
  },
  thresholds: {
    'http_req_duration{expected_response:true}': ['p(99)<150'],
    // 60 req/min per key policy, 2 keys, 60 s → about 120 allowed (+ initial burst).
    ratelimit_allowed: [`count<${Number(__ENV.MAX_ALLOWED || 400)}`],
  },
};

export default function () {
  const key = `10.0.0.${__VU % 2}`;
  const res = http.get(`${urls.api}/api/products/search?q=iphone`, {
    headers: { 'X-Forwarded-For': key },
    tags: { name: 'GET /api/products/search' },
    responseCallback: http.expectedStatuses(200, 429, 503),
  });
  if (res.status === 200) allowed.add(1);
  if (res.status === 429) {
    limited.add(1);
    check(res, {
      'has Retry-After': (r) => Number(r.headers['Retry-After']) >= 1,
      'has RateLimit-Policy': (r) => POLICY_ITEM.test(r.headers['Ratelimit-Policy'] || ''),
      'has RateLimit': (r) => LIMIT_ITEM.test(r.headers['Ratelimit'] || ''),
      'is not cacheable': (r) => r.headers['Cache-Control'] === 'no-store',
      'is problem+json': (r) => (r.headers['Content-Type'] || '').includes('application/problem+json'),
    });
  }
  if (res.status === 503) {
    unavailable.add(1);
    check(res, { 'has Retry-After 1': (r) => r.headers['Retry-After'] === '1' });
  }
}
