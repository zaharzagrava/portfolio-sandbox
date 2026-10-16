// SD-21 - on-sale spike: 0 → 20k VUs in 30 s hit a launch event's waiting room.
//
//   k6 run -e EVENT_ID=<uuid> -e PROFILE=load scripts/load-tests/launch-event.test.js
//
// Each VU: login → join queue (201 for a new ticket, 200 when the buyer already has one) → poll status until
// `admitted` (the SSE topic queue:<ticket> is the push path; polling here keeps the script dependency-free, and every
// poll is also the ticket's heartbeat) → once admitted, hold a random seat with `X-Admission-Token` and an
// `Idempotency-Key` → confirm with its own `Idempotency-Key`. Thresholds encode SD-21 / S22 SC-004: join stays fast under
// the spike (Redis only), holds stay fast (Redis + Dynamo), the seat map is cheap. After the run
//   SELECT "eventId", seat, count(*) FROM "Booking" WHERE status='CONFIRMED' GROUP BY "eventId", seat HAVING count(*) > 1
// must return zero rows (S22 SC-001: no double booking).
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
const shed = new Counter('launch_queue_shed');

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

const key = (kind) => `${kind}-${__VU}-${__ITER}-${Math.random().toString(36).slice(2, 10)}`;

export default function () {
  const login = http.post(`${urls.api}/api/auth/login`, JSON.stringify({ email: users[__VU % users.length], password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (login.status !== 200) return;
  const auth = { Authorization: `Bearer ${login.json('accessToken.token')}`, 'Content-Type': 'application/json' };

  const join = http.post(`${urls.api}/api/launch-events/${EVENT_ID}/queue`, null, { headers: auth, tags: { name: 'POST /queue' } });
  if (join.status === 503) return shed.add(1); // WAITING_ROOM_FULL / _UNAVAILABLE: Retry-After says when to come back
  if (join.status !== 201 && join.status !== 200) return;
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
    headers: { ...auth, 'X-Admission-Token': token, 'Idempotency-Key': key('hold') },
    tags: { name: 'POST /holds' },
  });
  if (hold.status === 409) return seatTaken.add(1); // SEAT_TAKEN
  check(hold, { held: (r) => r.status === 201 });
  if (hold.status !== 201) return;

  const ok = http.post(`${urls.api}/api/launch-holds/${hold.json('holdId')}/confirm`, '{}', {
    headers: { ...auth, 'Idempotency-Key': key('confirm') },
    tags: { name: 'POST /confirm' },
  });
  if (ok.status === 201 || ok.status === 200) confirmed.add(1);
}
