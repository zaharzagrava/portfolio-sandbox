// S29 SC-005 / AS-61 - photo upload permission under load: 600 requests per second for two minutes.
//
//   node scripts/load-tests/seed/index.js payment                          (seeded buyers)
//   k6 run -e PROFILE=load scripts/load-tests/media-presign.k6.js
//
// One iteration = one seeded buyer asks `POST /api/media/uploads {purpose: "review"}` and gets a signed permission.
// No image byte is sent: the API only signs (the body of the answer is a few hundred bytes). The per-user budget is
// 30 requests per minute (`media.upload.user`) and 50 waiting slots, so the arrival rate is spread over many accounts.
// SLO: p95 < 300 ms at 600 req/s, no response above 4 KiB. A 429 or 409 is a clean refusal, not a failure of the rate.
// This is an ops artifact (specs/UNVERIFIED.md): the automated suite proves correctness (AS-01, AS-05), not the rate.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { urls, PASSWORD } from './lib/config.js';

const users = new SharedArray('buyers', () => JSON.parse(open('./data/payment.json')).users.map((u) => u.email));
const tokens = {};
const rate = Number(__ENV.RATE || 600);

export const options = {
  scenarios: {
    presign: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: Math.min(rate, 1000),
      maxVUs: Math.min(rate * 3, 5000),
    },
  },
  thresholds: {
    'http_req_duration{name:POST /api/media/uploads}': ['p(95)<300'],
    'http_req_failed{name:POST /api/media/uploads}': ['rate<0.001'],
    checks: ['rate>0.99'],
  },
};

function tokenFor(email) {
  if (tokens[email]) return tokens[email];
  const login = http.post(`${urls.api}/api/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'POST /api/auth/login' },
  });
  if (login.status !== 200) return null;
  tokens[email] = login.json('accessToken.token');
  return tokens[email];
}

export default function () {
  const email = users[(__VU * 7919 + __ITER) % users.length];
  const token = tokenFor(email);
  if (!token) return;
  const res = http.post(`${urls.api}/api/media/uploads`, JSON.stringify({ purpose: 'review' }), {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    tags: { name: 'POST /api/media/uploads' },
    responseCallback: http.expectedStatuses(201, 409, 429),
  });
  check(res, {
    'permission issued or refused cleanly': (r) => [201, 409, 429].includes(r.status),
    'answer is small (no image byte involved)': (r) => r.body.length < 4096,
  });
}
