// SD-34 - product detail under a Zipf (power-law) popularity distribution.
//
//   node scripts/load-tests/seed/index.js catalog     (existing catalog seeder)
//   k6 run -e PROFILE=load scripts/load-tests/product-detail.test.js
//
// Real traffic is skewed: a few products (the new iPhone) get most views.
// That's what makes L1 hot-key promotion, single-flight and SWR matter.
// Watch `cache_requests_total{outcome}` in Grafana: misses should be a tiny
// fraction and origin (Postgres) QPS should stay flat as RPS grows.
// Run at 1/2/4 API instances for the linear-scaling check (D25).
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { urls } from './lib/config.js';

const products = new SharedArray('product ids', () => JSON.parse(open('./data/catalog.json')).productIds);
const S = Number(__ENV.ZIPF_S || 1.1);

// Precomputed Zipf CDF over product ranks.
const cdf = (() => {
  const weights = products.map((_, i) => 1 / Math.pow(i + 1, S));
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return weights.map((w) => (acc += w / total));
})();

function zipfIndex() {
  const r = Math.random();
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const options = {
  scenarios: {
    detail: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 2000),
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: 200,
      maxVUs: 2000,
    },
  },
  thresholds: {
    'http_req_duration{name:GET /api/products/:id}': ['p(99)<20'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const id = products[zipfIndex()];
  const res = http.get(`${urls.api}/api/products/${id}`, {
    headers: { 'CF-Connecting-IP': `10.1.${__VU % 250}.${__ITER % 250}` },
    tags: { name: 'GET /api/products/:id' },
  });
  check(res, { 'status 200/304': (r) => r.status === 200 || r.status === 304 });
}
