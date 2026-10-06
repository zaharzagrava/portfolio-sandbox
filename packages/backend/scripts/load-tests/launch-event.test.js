// SD-21 - on-sale spike: 0 → 20k VUs in 30 s hit a launch event's waiting room.
//
//   k6 run -e EVENT_ID=<uuid> -e PROFILE=load scripts/load-tests/launch-event.test.js
//
// Each VU: login → join queue → poll status (the SSE topic queue:<ticket> is the
// push path; polling here keeps the script dependency-free) → once admitted, try
// to hold a random seat → confirm. Thresholds encode SD-21: join stays fast under
// the spike (Redis only), holds stay fast (Redis + Dynamo), and after the run
//   SELECT seat, count(*) FROM "Booking" WHERE status='CONFIRMED' GROUP BY seat HAVING count(*) > 1
// must return zero rows (no double booking).
import http from 'k6/http';
import { sleep, check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { urls, PASSWORD } from './lib/config.js';

const users = new SharedArray('buyers', () => JSON.parse(open('./data/payment.json')).users.map((u) => u.email));
const EVENT_ID = __ENV.EVENT_ID;
const SEATS = Number(__ENV.SEATS || 800);

const confirmed = new Counter('launch_bookings_confirmed');
const seatTaken = new Counter('launch_seat_taken');

export const options = {
  scenarios: {
    onsale: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: Number(__ENV.PEAK_VUS || 20000) },
        { duration: '3m', target: Number(__ENV.PEAK_VUS || 20000) },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    'http_req_duration{name:POST /queue}': ['p(99)<100'],
    'http_req_duration{name:POST /holds}': ['p(99)<150'],
    'http_req_duration{name:GET /seatmap}': ['p(99)<50'],
  },
};

export default function () {
  const login = http.post(`${urls.api}/api/auth/login`, JSON.stringify({ email: users[__VU % users.length], password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (login.status !== 200) return;
  const auth = { Authorization: `Bearer ${login.json('accessToken.token')}`, 'Content-Type': 'application/json' };

  const join = http.post(`${urls.api}/api/launch-events/${EVENT_ID}/queue`, null, { headers: auth, tags: { name: 'POST /queue' } });
  if (join.status !== 201) return;
  const ticket = join.json('ticket');

  let token = join.json('admissionToken');
  for (let i = 0; i < 120 && !token; i++) {
    sleep(1 + Math.random());
    token = http.get(`${urls.api}/api/launch-events/${EVENT_ID}/queue/${ticket}`, { headers: auth, tags: { name: 'GET /queue status' } }).json('admissionToken');
  }
  if (!token) return;

  http.get(`${urls.api}/api/launch-events/${EVENT_ID}/seatmap`, { tags: { name: 'GET /seatmap' } });
  const seat = Math.floor(Math.random() * SEATS);
  const hold = http.post(`${urls.api}/api/launch-events/${EVENT_ID}/holds`, JSON.stringify({ seats: [seat] }), {
    headers: { ...auth, 'X-Admission-Token': token },
    tags: { name: 'POST /holds' },
  });
  if (hold.status === 409) return seatTaken.add(1);
  check(hold, { 'held': (r) => r.status === 201 });
  if (hold.status !== 201) return;

  const ok = http.post(`${urls.api}/api/launch-holds/${hold.json('holdId')}/confirm`, null, { headers: auth, tags: { name: 'POST /confirm' } });
  if (ok.status === 201) confirmed.add(1);
}
