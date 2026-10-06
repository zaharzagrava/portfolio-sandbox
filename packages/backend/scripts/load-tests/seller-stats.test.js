// Flow 3 - sellers log in and open their stats dashboard (ClickHouse).
//
//   node scripts/load-tests/seed/index.js seller-stats
//   k6 run -e PROFILE=load scripts/load-tests/seller-stats.test.js
//
// Each seller has ~120 days of sales history in ClickHouse; every call picks
// a 7/30/90-day window, i.e. three aggregate queries (summary + daily series
// + top products) per request.
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { PASSWORD, baseThresholds, buildScenario, urls } from './lib/config.js';
import { authHeaders, login, safeJson } from './lib/auth.js';
import { pick, randomBetween } from './lib/utils.js';
import { summaryFor } from './lib/summary.js';

const sellers = new SharedArray('sellers', () => JSON.parse(open('./data/seller-stats.json')).sellers);

const STATS_CALLS_PER_SELLER = Number(__ENV.STATS_CALLS_PER_SELLER || 5);

export const options = {
  scenarios: {
    'seller-stats': buildScenario(sellers.length, {
      smoke: { vus: 5, iterations: 20, maxDuration: '3m' },
      load: { vus: 300, maxDuration: '30m' },
      stress: { vus: 1500, maxDuration: '30m' },
    }),
  },
  thresholds: {
    ...baseThresholds,
    'http_req_duration{name:GET /api/sellers/me/stats}': ['p(95)<500', 'p(99)<1500'],
    'http_req_failed{name:GET /api/sellers/me/stats}': ['rate<0.01'],
  },
};

export default function () {
  const email = sellers[exec.scenario.iterationInTest % sellers.length];

  const session = login(email, PASSWORD);
  if (!session) return;

  check(session.user, { 'login: role is SELLER': (u) => u && u.role === 'SELLER' });

  for (let i = 0; i < STATS_CALLS_PER_SELLER; i++) {
    const days = pick([7, 30, 90]);

    const res = http.get(`${urls.api}/api/sellers/me/stats?days=${days}`, {
      headers: authHeaders(session.token),
      tags: { name: 'GET /api/sellers/me/stats', days: String(days) },
    });

    check(res, {
      'stats: status 200': (r) => r.status === 200,
      'stats: scoped to caller': (r) => safeJson(r, 'sellerId') === session.user.id,
      'stats: has orders': (r) => (safeJson(r, 'summary.orders') || 0) > 0,
    });

    // Dashboard dwell time between filter changes
    sleep(randomBetween(1, 3));
  }
}

export const handleSummary = summaryFor('seller-stats');
