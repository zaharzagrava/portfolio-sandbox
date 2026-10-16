// SD-15 / S23 - live launch stream: SSE fan-out plus a comment flood (ops artifact for SC-003 and SC-014).
//
// Requires a k6 build with the SSE extension (https://github.com/phymbert/xk6-sse):
//   xk6 build --with github.com/phymbert/xk6-sse
//   ./k6 run -e STREAM_ID=<uuid> -e TOKENS_FILE=./tokens.json -e PROFILE=load scripts/load-tests/live-stream.test.js
//
// Two scenarios:
//  - `viewers`: N anonymous event connections (`GET /api/live/:streamId/events`) held for SESSION_SECONDS. Each one measures
//    the delivery lag of a batched comment (`now - comment.at`, `live_delivery_ms`) and counts batches per second.
//  - `chatters`: COMMENT_RATE comments per second from the signed-in accounts of TOKENS_FILE (a JSON array of access
//    tokens; one comment per token per 3 seconds stays inside the per-user limit of `live.comment`).
// The stream must be LIVE (start it through `POST /api/shops/:shopId/live/:streamId/start`). SC-014: raise VUS on a deployed
// gateway until it answers `503 gateway_full`; the instance must still hold ONE upstream subscription per stream.
// Results are measured, not claimed here (specs/UNVERIFIED.md, status "not run").
import http from 'k6/http';
import sse from 'k6/x/sse';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import { PROFILE } from './lib/config.js';

const SSE_URL = __ENV.SSE_URL || 'http://localhost:8001';
const API_URL = __ENV.API_URL || 'http://localhost:8000';
const STREAM_ID = __ENV.STREAM_ID;
const SESSION_SECONDS = Number(__ENV.SESSION_SECONDS || 60);
const COMMENT_RATE = Number(__ENV.COMMENT_RATE || 5000);

const profiles = {
  smoke: { viewers: 20, chatters: 5 },
  load: { viewers: 5000, chatters: 200 },
  stress: { viewers: 50000, chatters: 500 },
};

const tokens = new SharedArray('tokens', () => (__ENV.TOKENS_FILE ? JSON.parse(open(__ENV.TOKENS_FILE)) : []));

const delivery = new Trend('live_delivery_ms', true);
const batches = new Counter('live_batches_received');
const commentsSeen = new Counter('live_comments_received');
const connectFailures = new Counter('live_connect_failures');
const gatewayFull = new Counter('live_gateway_full');
const accepted = new Counter('live_comments_accepted');

export const options = {
  scenarios: {
    viewers: {
      executor: 'per-vu-iterations',
      vus: Number(__ENV.VUS || profiles[PROFILE].viewers),
      iterations: 1,
      maxDuration: `${SESSION_SECONDS + 60}s`,
      exec: 'viewer',
    },
    chatters: {
      executor: 'constant-arrival-rate',
      rate: COMMENT_RATE,
      timeUnit: '1s',
      duration: `${SESSION_SECONDS}s`,
      startTime: '15s',
      preAllocatedVUs: Number(__ENV.CHATTERS || profiles[PROFILE].chatters),
      maxVUs: Number(__ENV.CHATTERS || profiles[PROFILE].chatters) * 4,
      exec: 'chatter',
    },
  },
  thresholds: {
    // SC-003: 99% of the viewers' batches carry comments no older than a second.
    live_delivery_ms: ['p(99)<1000'],
    live_connect_failures: ['count<10'],
  },
};

export function viewer() {
  const response = sse.open(`${SSE_URL}/api/live/${STREAM_ID}/events`, { timeout: `${SESSION_SECONDS + 20}s` }, (stream) => {
    stream.on('event', (event) => {
      if (event.name !== 'comments' || !event.data) return;
      const { items } = JSON.parse(event.data);
      batches.add(1);
      commentsSeen.add(items.length);
      const now = Date.now();
      for (const item of items) delivery.add(now - item.at);
    });
    stream.on('error', () => connectFailures.add(1));
    setTimeout(() => stream.close(), (SESSION_SECONDS + 10) * 1000);
  });
  if (response && response.status === 503) gatewayFull.add(1);
  else check(response, { 'sse status 200': (r) => r && r.status === 200 }) || connectFailures.add(1);
}

export function chatter() {
  if (tokens.length === 0) return;
  const token = tokens[__VU % tokens.length];
  const res = http.post(
    `${API_URL}/api/live/${STREAM_ID}/comments`,
    JSON.stringify({ text: `load ${__VU}-${__ITER}` }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, tags: { name: 'POST /comments' } },
  );
  if (res.status === 201) accepted.add(1);
}
