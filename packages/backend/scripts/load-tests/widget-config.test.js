// SD-01 / S44 - the public widget configuration: `GET /api/widget/v1/config?key=` at 50,000 requests a second over
// 10,000 sites, behind a CDN stand-in (the response is `public, s-maxage=60`, `Vary: Origin`).
//
//   1. Seed 10,000 sites straight into the table (the dashboard allows 10 per shop and 60 writes a minute):
//        psql "$DATABASE_URL" -c "INSERT INTO \"WidgetSite\" (\"shopId\", \"publishableKey\", \"allowedOrigins\",
//          \"identitySecretSealed\", \"shopName\", \"shopVersion\")
//          SELECT s.id, 'pk_live_' || lpad(i::text, 24, '0'), ARRAY['https://load.example'], 'v1.x.x.x', s.name, 1
//          FROM generate_series(1, 10000) i CROSS JOIN LATERAL (SELECT id, name FROM \"Shop\" LIMIT 1) s"
//   2. Put a caching proxy that honours `s-maxage` and `Vary: Origin` in front of the core (any CDN, or nginx
//      `proxy_cache`), and send the traffic to it:
//        k6 run -e BASE_URL=https://cdn-stand-in.example -e SITES=10000 scripts/load-tests/widget-config.test.js
//
// SLO (S44 SC-007): at least 99% of the requests are answered by the intermediary without reaching the application.
// The script counts the answers carrying the `Age` header (or `X-Cache: HIT`) as served by the intermediary. This is an
// ops artifact (specs/UNVERIFIED.md): the automated suite proves the headers that make the answer cacheable (S44 AS-14),
// not the throughput.
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const SITES = Number(__ENV.SITES || 10000);
const RATE = Number(__ENV.RATE || 50000);
const ORIGIN = __ENV.ORIGIN || 'https://load.example';
const served = new Rate('widget_config_served_by_intermediary');

export const options = {
  scenarios: {
    visitors: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '5m',
      preAllocatedVUs: Math.min(RATE, 2000),
      maxVUs: Math.min(RATE * 2, 10000),
    },
  },
  thresholds: {
    widget_config_served_by_intermediary: ['rate>=0.99'],
    'http_req_failed{name:GET widget config}': ['rate<0.001'],
  },
};

export default function () {
  const key = `pk_live_${String(1 + Math.floor(Math.random() * SITES)).padStart(24, '0')}`;
  const res = http.get(`${BASE_URL}/api/widget/v1/config?key=${key}`, {
    headers: { Origin: ORIGIN },
    tags: { name: 'GET widget config' },
  });
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    cacheable: (r) => /s-maxage=60/.test(r.headers['Cache-Control'] || ''),
  });
  if (ok) served.add(Boolean(res.headers['Age']) || /HIT/i.test(res.headers['X-Cache'] || ''));
}
