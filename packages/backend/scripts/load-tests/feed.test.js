// S26 - follow graph and home feed: fan-out lag (SC-001) and feed read latency (SC-004).
//
//   node scripts/load-tests/seed/index.js payment                 (seeded buyers = followers; at least FOLLOWERS accounts)
//   k6 run -e PROFILE=load -e AUTHOR_EMAIL=<author> -e AUTHOR_ACCOUNT_ID=user:<uuid> -e BOARD_ID=<product uuid> \
//          [-e PROBE_COUNT=20] [-e REBUILD_EMAIL=<user following 500 accounts>] scripts/load-tests/feed.test.js
//
// Scenarios (run in order by start times):
//   follow   one iteration = one seeded buyer: login, follow AUTHOR_ACCOUNT_ID, read the feed once (marks the buyer
//            active, so the author's items are fanned out to the buyer's timeline). 10,000 followers, ~30% read the feed.
//   fanout   the author publishes a discussion post; one active follower (PROBE_COUNT of them in turn) polls GET /api/feed
//            until the item appears. The lag is the Trend `feed_fanout_lag_seconds`; items never seen count in
//            `feed_fanout_missed`. SC-001: p99 < 5 s.
//   reads    constant arrival rate of first-page loads by seeded buyers with a populated timeline. SC-004: p95 < 300 ms.
//            Run the whole script with 1, 2 and 4 core instances (the API_URL load balancer) and compare.
//   rebuild  REBUILD_EMAIL follows 500 accounts; flush the cache Redis database (`FLUSHDB`) before the run so the
//            first page is a rebuild. SC-004: first page p95 < 2 s. Skipped when REBUILD_EMAIL is unset.
//
// This is an ops artifact (specs/UNVERIFIED.md, status "not run"): the automated suite proves correctness
// (AS-13, AS-32, AS-37, AS-44), not the time.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import { urls, PASSWORD, PROFILE, buildScenario } from './lib/config.js';

const users = new SharedArray('followers', () => JSON.parse(open('./data/payment.json')).users.map((u) => u.email));
const AUTHOR_EMAIL = __ENV.AUTHOR_EMAIL;
const AUTHOR_ACCOUNT_ID = __ENV.AUTHOR_ACCOUNT_ID;
const BOARD_ID = __ENV.BOARD_ID;
const REBUILD_EMAIL = __ENV.REBUILD_EMAIL;
const PROBE_COUNT = Number(__ENV.PROBE_COUNT || 20);
const ACTIVE_RATIO = Number(__ENV.ACTIVE_RATIO || 0.3);
const FANOUT_TIMEOUT_S = Number(__ENV.FANOUT_TIMEOUT_S || 30);

const fanoutLag = new Trend('feed_fanout_lag_seconds');
const fanoutMissed = new Counter('feed_fanout_missed');
const followsDone = new Counter('feed_follows_done');
const rebuildFirstPage = new Trend('feed_rebuild_first_page_ms', true);

const readRate = { smoke: 5, load: 2000, stress: 5000 }[PROFILE] || 5;
const json = { 'Content-Type': 'application/json' };

export const options = {
  scenarios: {
    follow: {
      ...buildScenario(users.length, {
        smoke: { vus: 5, iterations: 20, maxDuration: '5m' },
        load: { vus: 500, iterations: 10000, maxDuration: '15m' },
        stress: { vus: 1000, iterations: 10000, maxDuration: '15m' },
      }),
      exec: 'follow',
    },
    fanout: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: PROBE_COUNT,
      startTime: __ENV.FANOUT_START || '16m',
      maxDuration: '20m',
      exec: 'fanout',
    },
    reads: {
      executor: 'constant-arrival-rate',
      rate: readRate,
      timeUnit: '1s',
      duration: __ENV.READ_DURATION || '3m',
      preAllocatedVUs: Math.min(readRate, 1000),
      maxVUs: Math.min(readRate * 2, 10000),
      startTime: __ENV.READS_START || '16m',
      exec: 'reads',
    },
    ...(REBUILD_EMAIL
      ? {
          rebuild: {
            executor: 'per-vu-iterations',
            vus: 1,
            iterations: 1,
            startTime: __ENV.REBUILD_START || '20m',
            exec: 'rebuild',
          },
        }
      : {}),
  },
  thresholds: {
    feed_fanout_lag_seconds: ['p(99)<5'],
    feed_fanout_missed: ['count==0'],
    'http_req_duration{name:GET feed}': ['p(95)<300'],
    'http_req_failed{name:GET feed}': ['rate<0.001'],
    feed_rebuild_first_page_ms: ['p(95)<2000'],
  },
};

function login(email) {
  const res = http.post(`${urls.api}/api/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: json,
    tags: { name: 'POST /api/auth/login' },
  });
  return res.status === 200 ? res.json('accessToken.token') : null;
}

function auth(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// One login per VU for the read scenarios: a read VU keeps its buyer.
let vuToken = null;
let vuEmail = null;
function vuAuth() {
  if (!vuToken) {
    vuEmail = users[(__VU - 1) % users.length];
    vuToken = login(vuEmail);
  }
  return vuToken ? auth(vuToken) : null;
}

export function follow() {
  const email = users[__ITER % users.length];
  const token = login(email);
  if (!token) return;
  const res = http.post(`${urls.api}/api/follow/${AUTHOR_ACCOUNT_ID}`, null, {
    headers: auth(token),
    tags: { name: 'POST /api/follow' },
  });
  check(res, { 'follow 204': (r) => r.status === 204 });
  if (res.status === 204) followsDone.add(1);
  // the active share: only these buyers open their feed (and so own a timeline) before the author publishes
  if ((__ITER % 100) / 100 < ACTIVE_RATIO) {
    http.get(`${urls.api}/api/feed?limit=20`, { headers: auth(token), tags: { name: 'GET feed (activate)' } });
  }
}

export function fanout() {
  const authorToken = login(AUTHOR_EMAIL);
  // probes are drawn from the active share (iteration index below the active ratio of the follow scenario)
  const probeIndex = (__ITER * Math.floor(100 / (ACTIVE_RATIO * 100))) % users.length;
  const probeToken = login(users[probeIndex]);
  if (!authorToken || !probeToken) return;

  const started = Date.now();
  const created = http.post(
    `${urls.api}/api/boards/${BOARD_ID}/posts`,
    JSON.stringify({ title: `feed lag probe ${__ITER} ${started}`, body: 'S26 fan-out lag probe' }),
    {
      headers: { ...auth(authorToken), 'Idempotency-Key': `feed-lag-${__VU}-${__ITER}-${started}` },
      tags: { name: 'POST post' },
    },
  );
  if (created.status !== 201 && created.status !== 200) return;
  const postId = created.json('postId');

  let seen = false;
  while (!seen && (Date.now() - started) / 1000 < FANOUT_TIMEOUT_S) {
    const page = http.get(`${urls.api}/api/feed?limit=20`, { headers: auth(probeToken), tags: { name: 'GET feed (probe)' } });
    if (page.status === 200) {
      seen = (page.json('items') || []).some((i) => i.kind === 'post' && i.payload && i.payload.postId === postId);
    }
    if (!seen) sleep(0.1);
  }
  if (seen) fanoutLag.add((Date.now() - started) / 1000);
  else fanoutMissed.add(1);
}

export function reads() {
  const headers = vuAuth();
  if (!headers) return;
  const res = http.get(`${urls.api}/api/feed?limit=20`, { headers, tags: { name: 'GET feed' } });
  check(res, { 'feed 200': (r) => r.status === 200 });
}

export function rebuild() {
  const token = login(REBUILD_EMAIL);
  if (!token) return;
  const res = http.get(`${urls.api}/api/feed?limit=20`, { headers: auth(token), tags: { name: 'GET feed (rebuild)' } });
  check(res, { 'rebuild first page 200': (r) => r.status === 200 });
  rebuildFirstPage.add(res.timings.duration);
}
