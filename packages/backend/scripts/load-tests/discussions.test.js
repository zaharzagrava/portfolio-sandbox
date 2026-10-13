// SD-11 / S25 - product discussions: a vote storm on one post while readers hit board and thread pages.
//
//   node scripts/load-tests/seed/index.js payment                         (seeded buyers = distinct voters)
//   node scripts/load-tests/seed/discussions-thread.js                    (prints BOARD_ID and POST_ID of a 50,000-comment thread)
//   k6 run -e PROFILE=load -e BOARD_ID=<product uuid> -e POST_ID=<post uuid> scripts/load-tests/discussions.test.js
//
// Votes: one iteration = one seeded buyer = one distinct voter casting +1 (write limit and vote limit are per user, so
// the storm is not throttled by itself). Reads: board `hot`/`new` first pages and the thread first page, anonymous.
// SLOs (S25 SC-002, SC-003, SC-005): vote p99 < 30 ms, board and thread reads p99 < 50 ms. After the run:
//   - the post's `ups` equals the number of distinct voters that got a 200 (the invariant below counts them);
//   - run the reconciliation (`discussions.reconcile`) and expect no "vote counts drifted" warning in the worker log.
// This is an ops artifact (specs/UNVERIFIED.md): the automated suite proves correctness (AS-29, AS-30, AS-18), not the rate.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { urls, PASSWORD, PROFILE, buildScenario } from './lib/config.js';

const users = new SharedArray('voters', () => JSON.parse(open('./data/payment.json')).users.map((u) => u.email));
const BOARD_ID = __ENV.BOARD_ID;
const POST_ID = __ENV.POST_ID;

const votesAccepted = new Counter('discussion_votes_accepted');
const votesRefused = new Counter('discussion_votes_refused');

const readRate = { smoke: 20, load: 50000, stress: 100000 }[PROFILE] || 20;

export const options = {
  scenarios: {
    voteStorm: {
      ...buildScenario(users.length, {
        smoke: { vus: 10, iterations: 50, maxDuration: '5m' },
        load: { vus: 2000, iterations: 100000, maxDuration: '10m' },
        stress: { vus: 10000, iterations: 1000000, maxDuration: '20m' },
      }),
      exec: 'vote',
    },
    readers: {
      executor: 'constant-arrival-rate',
      rate: readRate,
      timeUnit: '1s',
      duration: __ENV.READ_DURATION || '2m',
      preAllocatedVUs: Math.min(readRate, 2000),
      maxVUs: Math.min(readRate * 2, 20000),
      exec: 'read',
    },
  },
  thresholds: {
    'http_req_duration{name:PUT /api/votes}': ['p(99)<30'],
    'http_req_duration{name:GET board}': ['p(99)<50'],
    'http_req_duration{name:GET thread}': ['p(99)<50'],
    'http_req_failed{name:GET board}': ['rate<0.001'],
    'http_req_failed{name:GET thread}': ['rate<0.001'],
  },
};

export function vote() {
  const email = users[__ITER % users.length];
  const login = http.post(`${urls.api}/api/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'POST /api/auth/login' },
  });
  if (login.status !== 200) return;
  const res = http.put(`${urls.api}/api/votes/${POST_ID}`, JSON.stringify({ value: 1 }), {
    headers: { Authorization: `Bearer ${login.json('accessToken.token')}`, 'Content-Type': 'application/json' },
    tags: { name: 'PUT /api/votes' },
  });
  if (res.status === 200) votesAccepted.add(1);
  else votesRefused.add(1);
  check(res, { 'vote accepted or refused cleanly': (r) => [200, 409, 429, 503].includes(r.status) });
}

export function read() {
  const sort = ['hot', 'new', 'top'][__ITER % 3];
  const board = http.get(`${urls.api}/api/boards/${BOARD_ID}/posts?sort=${sort}&limit=25`, { tags: { name: 'GET board' } });
  check(board, { 'board 200': (r) => r.status === 200 });
  if (__ITER % 2 === 0) {
    const thread = http.get(`${urls.api}/api/posts/${POST_ID}/comments?sort=best`, { tags: { name: 'GET thread' } });
    check(thread, { 'thread 200': (r) => r.status === 200 });
  }
}
