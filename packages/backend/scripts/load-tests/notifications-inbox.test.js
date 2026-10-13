// Flow 7 - the bell: people open the inbox, read the unread count and mark things read (S28, SC-009).
//
//   node scripts/load-tests/seed/index.js notifications
//   k6 run -e PROFILE=load scripts/load-tests/notifications-inbox.test.js
//
// Not run in CI (specs/UNVERIFIED.md, S28 SC-009): the target is 30,000 requests per second across the fleet with
// p99 < 150 ms for `GET /api/notifications` and p99 < 50 ms for `GET /api/notifications/unread-count`. One iteration
// is one seeded account: log in, read the count, list a page, follow the cursor, mark the first item read, read the
// count again. Accounts with an empty inbox (no burst run before) still exercise the count and an empty page; run
// notifications-burst.test.js first for realistic pages.
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { PASSWORD, baseThresholds, buildScenario, urls } from './lib/config.js';
import { authHeaders, login, safeJson } from './lib/auth.js';
import { randomBetween } from './lib/utils.js';
import { summaryFor } from './lib/summary.js';

const users = new SharedArray('notification users', () => JSON.parse(open('./data/notifications.json')).users);

const READS_PER_ACCOUNT = Number(__ENV.READS_PER_ACCOUNT || 5);

export const options = {
  scenarios: {
    'notifications-inbox': buildScenario(users.length, {
      smoke: { vus: 5, iterations: 20, maxDuration: '3m' },
      load: { vus: 600, maxDuration: '30m' },
      stress: { vus: 3000, maxDuration: '30m' },
    }),
  },
  thresholds: {
    ...baseThresholds,
    'http_req_duration{name:GET /api/notifications}': ['p(99)<150'],
    'http_req_duration{name:GET /api/notifications/unread-count}': ['p(99)<50'],
    'http_req_failed{name:GET /api/notifications}': ['rate<0.001'],
    'http_req_failed{name:GET /api/notifications/unread-count}': ['rate<0.001'],
  },
};

export default function () {
  const account = users[exec.scenario.iterationInTest % users.length];
  const session = login(account.email, PASSWORD);
  if (!session) return;
  const headers = authHeaders(session.token);

  for (let i = 0; i < READS_PER_ACCOUNT; i++) {
    const count = http.get(`${urls.api}/api/notifications/unread-count`, {
      headers,
      tags: { name: 'GET /api/notifications/unread-count' },
    });
    check(count, {
      'unread-count: status 200': (r) => r.status === 200,
      'unread-count: within the rebuild bound': (r) => (safeJson(r, 'unread') ?? -1) >= 0 && safeJson(r, 'unread') <= 1000,
    });

    const page = http.get(`${urls.api}/api/notifications?limit=20`, {
      headers,
      tags: { name: 'GET /api/notifications' },
    });
    check(page, {
      'list: status 200': (r) => r.status === 200,
      'list: at most 20 items': (r) => (safeJson(r, 'items') || []).length <= 20,
    });

    const cursor = safeJson(page, 'nextCursor');
    if (cursor) {
      const next = http.get(`${urls.api}/api/notifications?limit=20&cursor=${encodeURIComponent(cursor)}`, {
        headers,
        tags: { name: 'GET /api/notifications' },
      });
      check(next, { 'list (cursor): status 200': (r) => r.status === 200 });
    }

    const first = (safeJson(page, 'items') || [])[0];
    if (first && !first.read) {
      const read = http.post(`${urls.api}/api/notifications/read`, JSON.stringify({ ids: [first.id] }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
        tags: { name: 'POST /api/notifications/read' },
      });
      check(read, { 'mark read: status 200': (r) => r.status === 200 });
    }

    // The bell is re-read on focus, not in a loop.
    sleep(randomBetween(1, 3));
  }
}

export const handleSummary = summaryFor('notifications-inbox');
