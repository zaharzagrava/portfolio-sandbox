// SC-005 of S16: closed-month statement reads, p95 < 300 ms and p99 < 2 s with 5 years of history.
// Performance job only; listed in specs/UNVERIFIED.md as `not run`.
//
//   Seed 60 closed months of snapshots for ~100k shops first (the close bench does one month),
//   then:  k6 run -e API_URL=http://host/api -e BEARER="Bearer ..." -e SHOPS=shops.json scripts/bench/statements-read.k6.js
//   `shops.json` is an array of { shopId, bearer } for shop owners; months are drawn from 2021-04 to 2026-03.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

const shops = new SharedArray('shops', () => JSON.parse(open(__ENV.SHOPS)));

export const options = {
  scenarios: { reads: { executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s', duration: '5m', preAllocatedVUs: 100 } },
  thresholds: { http_req_duration: ['p(95)<300', 'p(99)<2000'], http_req_failed: ['rate<0.01'] },
};

export default function () {
  const shop = shops[Math.floor(Math.random() * shops.length)];
  const index = Math.floor(Math.random() * 60);
  const month = `${2021 + Math.floor((index + 3) / 12)}-${String(((index + 3) % 12) + 1).padStart(2, '0')}`;
  const res = http.get(`${__ENV.API_URL}/shops/${shop.shopId}/statements/${month}`, { headers: { Authorization: shop.bearer } });
  check(res, { ok: (r) => r.status === 200 });
}
