// SD-08 / S37 - share links: Zipf-distributed redirects at the origin, an edge scenario, and a create storm.
//
//   node scripts/load-tests/seed/index.js payment                      (seeded buyers = distinct owners for the create scenario)
//   k6 run -e PROFILE=load -e FRONT=https://shop.example scripts/load-tests/share-links.test.js
//   k6 run -e SCENARIO=edge -e EDGE_URL=http://localhost:8787 ...      (against `wrangler dev`; compare origin request counts)
//
// Redirects: 1,000 codes created in setup (each by one seeded buyer, within the 20-per-minute create limit), then followed
// with a Zipf-like skew (a few codes take most of the traffic). The origin must answer 302 without following it.
// Creates: one iteration = one seeded buyer = one create with a fresh `Idempotency-Key`.
// SLOs (S37 SC-001, SC-002, SC-006): cached redirect p99 < 20 ms at the origin; 40,000 redirects/s through the edge with at
// most one origin request per code per edge location per 10 s; creates sustain 400/s. This is an ops artifact
// (specs/UNVERIFIED.md): the automated suite proves correctness (AS-24, AS-32, AS-41, AS-42), not the rate.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { urls, PASSWORD, PROFILE, buildScenario } from './lib/config.js';

const users = new SharedArray('owners', () => JSON.parse(open('./data/payment.json')).users.map((u) => u.email));
const FRONT = __ENV.FRONT || 'http://localhost:3000';
const EDGE_URL = __ENV.EDGE_URL;
const CODES = Number(__ENV.CODES || 1000);
const SCENARIO = __ENV.SCENARIO || 'origin';

const created = new Counter('share_links_created');
const refused = new Counter('share_links_refused');

const redirectRate = { smoke: 20, load: 40000, stress: 80000 }[PROFILE] || 20;
const createRate = { smoke: 5, load: 400, stress: 800 }[PROFILE] || 5;

const scenarios = {
  redirects: {
    executor: 'constant-arrival-rate',
    rate: redirectRate,
    timeUnit: '1s',
    duration: __ENV.READ_DURATION || '2m',
    preAllocatedVUs: Math.min(redirectRate, 2000),
    maxVUs: Math.min(redirectRate * 2, 20000),
    exec: 'follow',
  },
};
if (SCENARIO === 'origin')
  scenarios.creates = {
    executor: 'constant-arrival-rate',
    rate: createRate,
    timeUnit: '1s',
    duration: __ENV.CREATE_DURATION || '2m',
    preAllocatedVUs: Math.min(createRate, 1000),
    maxVUs: Math.min(createRate * 2, 4000),
    exec: 'create',
  };

export const options = {
  scenarios,
  thresholds: {
    'http_req_duration{name:GET /l/code}': ['p(99)<20'],
    'http_req_failed{name:GET /l/code}': ['rate<0.001'],
    'http_req_duration{name:POST /api/links}': ['p(99)<250'],
  },
};

const json = { 'Content-Type': 'application/json' };
const login = (email) => {
  const res = http.post(`${urls.api}/api/auth/login`, JSON.stringify({ email, password: PASSWORD }), { headers: json, tags: { name: 'POST /api/auth/login' } });
  return res.status === 200 ? res.json('accessToken.token') : null;
};

export function setup() {
  const codes = [];
  for (let i = 0; i < CODES; i++) {
    const token = login(users[i % users.length]);
    if (!token) continue;
    const res = http.post(`${urls.api}/api/links`, JSON.stringify({ destination: `${FRONT}/p/load-${i}` }), {
      headers: { ...json, Authorization: `Bearer ${token}`, 'Idempotency-Key': `load-setup-${i}-${Date.now()}` },
      tags: { name: 'setup create' },
    });
    if (res.status === 201) codes.push(res.json('code'));
  }
  return { codes };
}

/** Zipf-like: rank r is picked with weight 1/r, by squaring a uniform number. */
const pick = (codes) => codes[Math.floor(Math.pow(Math.random(), 3) * codes.length)];

export function follow(data) {
  const base = EDGE_URL ? `${EDGE_URL}/l` : `${urls.api}/api/l`;
  const res = http.get(`${base}/${pick(data.codes)}`, { redirects: 0, tags: { name: 'GET /l/code' } });
  check(res, { 'redirect 302': (r) => r.status === 302 });
}

export function create() {
  const token = login(users[__ITER % users.length]);
  if (!token) return;
  const res = http.post(`${urls.api}/api/links`, JSON.stringify({ destination: `${FRONT}/p/create-${__VU}-${__ITER}` }), {
    headers: { ...json, Authorization: `Bearer ${token}`, 'Idempotency-Key': `load-${__VU}-${__ITER}-${Date.now()}` },
    tags: { name: 'POST /api/links' },
  });
  if (res.status === 201) created.add(1);
  else refused.add(1);
  check(res, { 'create accepted or refused cleanly': (r) => [201, 422, 429, 503].includes(r.status) });
}
