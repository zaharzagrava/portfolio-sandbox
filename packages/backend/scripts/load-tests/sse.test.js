// F-03 - SSE fan-out through the realtime hub (apps/sse-gateway).
//
// Requires a k6 build with the SSE extension (https://github.com/phymbert/xk6-sse):
//   xk6 build --with github.com/phymbert/xk6-sse
//   ./k6 run -e PROFILE=load -e SSE_URL=http://localhost:8001 scripts/load-tests/sse.test.js
//
// Two scenarios:
//  - `viewers`: N connections subscribed to a handful of public auction topics.
//  - `publisher`: publishes PUBLISH_RATE events/s straight into Redis (XADD + PUBLISH,
//     same as RealtimePublisher) with the publish timestamp in the payload, so each
//     viewer measures publish -> gateway -> browser latency (`sse_delivery_ms`).
// Run at 1, 2, 4 gateway instances behind a LB to show linear connection scaling (D25).
import sse from 'k6/x/sse';
import redis from 'k6/experimental/redis';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { PROFILE } from './lib/config.js';

const SSE_URL = __ENV.SSE_URL || 'http://localhost:8001';
const TOPICS = Array.from({ length: Number(__ENV.TOPICS || 5) }, (_, i) => `auction:loadtest${i}`);
const PUBLISH_RATE = Number(__ENV.PUBLISH_RATE || 10);
const SESSION_SECONDS = Number(__ENV.SESSION_SECONDS || 60);

const profiles = {
  smoke: { viewers: 20 },
  load: { viewers: 5000 },
  stress: { viewers: 20000 },
};

const delivery = new Trend('sse_delivery_ms', true);
const received = new Counter('sse_events_received');
const connectFailures = new Counter('sse_connect_failures');

const client = new redis.Client(__ENV.REDIS_URL || 'redis://localhost:6300');

const storm = __ENV.STORM === '1'
  ? {
      storm: {
        executor: 'constant-vus',
        vus: Number(__ENV.STORM_VUS || 500),
        duration: `${SESSION_SECONDS}s`,
        exec: 'reconnectStorm',
      },
    }
  : {};

export const options = {
  scenarios: {
    ...storm,
    viewers: {
      executor: 'per-vu-iterations',
      vus: Number(__ENV.VUS || profiles[PROFILE].viewers),
      iterations: 1,
      maxDuration: `${SESSION_SECONDS + 60}s`,
      exec: 'viewer',
    },
    publisher: {
      executor: 'constant-arrival-rate',
      rate: PUBLISH_RATE,
      timeUnit: '1s',
      duration: `${SESSION_SECONDS}s`,
      startTime: '10s',
      preAllocatedVUs: 5,
      exec: 'publish',
    },
  },
  thresholds: {
    sse_delivery_ms: ['p(95)<500', 'p(99)<1000'],
    sse_connect_failures: ['count<10'],
  },
};

export function viewer() {
  const topic = TOPICS[__VU % TOPICS.length];
  const response = sse.open(`${SSE_URL}/api/streams?topics=${topic}`, { timeout: `${SESSION_SECONDS + 20}s` }, (stream) => {
    stream.on('event', (event) => {
      if (!event.data) return;
      const { data } = JSON.parse(event.data);
      if (data && data.sentAt) {
        delivery.add(Date.now() - data.sentAt);
        received.add(1);
      }
    });
    stream.on('error', () => connectFailures.add(1));
    setTimeout(() => stream.close(), (SESSION_SECONDS + 10) * 1000);
  });
  check(response, { 'sse status 200': (r) => r && r.status === 200 }) || connectFailures.add(1);
}

export async function publish() {
  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  const data = JSON.stringify({ price: Math.floor(Math.random() * 10000), sentAt: Date.now() });
  // Approximates RealtimePublisher (capped stream for replay + live publish). The product does both in one atomic
  // script; two commands are close enough for load shape, not for correctness.
  const id = await client.sendCommand('XADD', `rt:s:${topic}`, 'MAXLEN', '~', '1000', '*', 't', 'price', 'd', data);
  await client.publish(`rt:c:${topic}`, JSON.stringify({ id, topic, type: 'price', data: JSON.parse(data), ts: Date.now() }));
}

// Reconnect storm (S51 SC-007): every viewer holds a connection for a short random time, then reconnects at once, the way a
// deploy drops a fleet. Run it with `-e STORM=1` while restarting the gateway instances; `sse_storm_reconnect_ms` is the
// time from a drop to the first frame of the new connection. Results are measured, not claimed here.
const stormReconnect = new Trend('sse_storm_reconnect_ms', true);
export function reconnectStorm() {
  const topic = TOPICS[__VU % TOPICS.length];
  const started = Date.now();
  let first = true;
  sse.open(`${SSE_URL}/api/streams?topics=${topic}`, { timeout: `${SESSION_SECONDS}s` }, (stream) => {
    stream.on('event', () => {
      if (first) stormReconnect.add(Date.now() - started);
      first = false;
    });
    stream.on('error', () => connectFailures.add(1));
    setTimeout(() => stream.close(), (5 + Math.random() * 10) * 1000);
  });
}
