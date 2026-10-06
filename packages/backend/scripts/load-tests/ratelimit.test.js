// SD-28 - distributed rate limiter accuracy and overhead.
//
//   k6 run -e PROFILE=load scripts/load-tests/ratelimit.test.js
//
// Hammers the token-bucket-limited search endpoint as a handful of "users"
// (anonymous → keyed by IP, so pass a distinct X-Forwarded-For per VU group
// through a trusted proxy, or log in seeded users with -e AUTH=1) at ~2x the
// allowed rate. Run against 1, 2 and 4 API instances behind a load balancer:
// the number of 200s per key must stay ≈ the policy budget regardless of the
// instance count (shared Redis state), and p99 latency overhead must stay
// small (local leases avoid a Redis call on most requests).
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { urls } from './lib/config.js';

const allowed = new Counter('ratelimit_allowed');
const limited = new Counter('ratelimit_limited');

export const options = {
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
    headers: { 'CF-Connecting-IP': key },
    tags: { name: 'GET /api/products/search' },
  });
  if (res.status === 200) allowed.add(1);
  if (res.status === 429) {
    limited.add(1);
    check(res, { 'has Retry-After': (r) => Number(r.headers['Retry-After']) > 0 });
  }
}
