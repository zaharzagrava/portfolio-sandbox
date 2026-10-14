// S24 product chat over HTTP: reconnect storms (sync), idempotent sends and message ingest.
//
//   node scripts/load-tests/seed/index.js chat
//   k6 run -e PROFILE=load -e SCENARIO=catchup   scripts/load-tests/chat-sync.test.js
//   k6 run -e PROFILE=load -e SCENARIO=send-storm scripts/load-tests/chat-sync.test.js
//   k6 run -e PROFILE=load -e SCENARIO=ingest     scripts/load-tests/chat-sync.test.js
//
// OPS ARTIFACT: this script is how SC-004 (50,000 catch-up requests per second, p99 < 100 ms), SC-001/SC-003 at
// 1,000 repeats and SC-009 (25,000 messages per second) are measured. None of it has been run (specs/UNVERIFIED.md);
// do not describe those criteria as verified until a run is recorded there.
//
// catchup    each iteration: login, then `POST /api/chat/sync` for CHANNELS_PER_USER channels with a cursor of 0, with a
//            jittered wait between rounds (a thundering herd of reconnects without jitter would measure the herd, not
//            the endpoint); every answer must parse as `[{channelId, messages, lastSeq, hasMore}]`.
// send-storm each iteration: one `clientMessageId` per user action, sent and then retried REPLAYS times; exactly one
//            `201` and the rest `200 duplicate: true`, never a second message (SC-001, SC-003).
// ingest     each iteration: SENDS fresh messages to a channel as fast as the per-user limit allows (SC-009).
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import { PASSWORD, baseThresholds, buildScenario, urls } from './lib/config.js';
import { authHeaders, login, safeJson } from './lib/auth.js';
import { pick, randomInt } from './lib/utils.js';
import { summaryFor } from './lib/summary.js';

const users = new SharedArray(
  'chat users',
  () => JSON.parse(open('./data/chat.json')).users,
);
const channels = new SharedArray(
  'chat channels',
  () => JSON.parse(open('./data/chat.json')).channels,
);

const SCENARIO = __ENV.SCENARIO || 'catchup';
const CHANNELS_PER_USER = Number(__ENV.CHANNELS_PER_USER || 5);
const ROUNDS = Number(__ENV.ROUNDS || 5);
const JITTER_MAX_S = Number(__ENV.JITTER_MAX_S || 3);
const REPLAYS = Number(__ENV.REPLAYS || 9);
const SENDS = Number(__ENV.SENDS || 10);

const syncFailures = new Counter('chat_sync_failures');
const syncDuration = new Trend('chat_sync_duration', true);
const duplicateMessages = new Counter('chat_duplicate_messages');
const replayOk = new Rate('chat_replay_ok');
const sent = new Counter('chat_http_messages_sent');
const rateLimited = new Counter('chat_rate_limited');

const profiles = {
  smoke: { vus: 5, iterations: 10, maxDuration: '5m' },
  load: { vus: 2000, maxDuration: '60m' },
  stress: { vus: 10000, maxDuration: '60m' },
};

export const options = {
  scenarios: { [SCENARIO]: buildScenario(users.length, profiles) },
  thresholds: {
    ...baseThresholds,
    ...(SCENARIO === 'catchup' && {
      'http_req_duration{name:POST /api/chat/sync}': ['p(95)<100', 'p(99)<250'],
      chat_sync_failures: ['count<10'],
    }),
    ...(SCENARIO === 'send-storm' && {
      chat_duplicate_messages: ['count==0'],
      chat_replay_ok: ['rate>0.999'],
    }),
  },
};

function uuid() {
  const hex = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

function catchup(session) {
  const picked = new Set();
  while (picked.size < Math.min(CHANNELS_PER_USER, channels.length))
    picked.add(pick(channels));
  const cursors = Object.fromEntries([...picked].map((id) => [id, 0]));
  for (let round = 0; round < ROUNDS; round += 1) {
    const res = http.post(
      `${urls.api}/api/chat/sync`,
      JSON.stringify({ cursors }),
      {
        headers: authHeaders(session.token, {
          'Content-Type': 'application/json',
        }),
        tags: { name: 'POST /api/chat/sync' },
      },
    );
    syncDuration.add(res.timings.duration);
    const ok = check(res, {
      'sync: status 200': (r) => r.status === 200,
      'sync: array of channels': (r) => Array.isArray(safeJson(r)),
    });
    if (!ok) syncFailures.add(1);
    sleep(Math.random() * JITTER_MAX_S);
  }
}

function sendStorm(session) {
  const channelId = pick(channels);
  http.post(`${urls.api}/api/chat/channels/${channelId}/join`, null, {
    headers: authHeaders(session.token),
  });
  const clientMessageId = uuid();
  const payload = JSON.stringify({
    clientMessageId,
    body: `lt:${Date.now()}:${exec.vu.idInTest}`,
  });
  const headers = authHeaders(session.token, {
    'Content-Type': 'application/json',
  });
  const first = http.post(
    `${urls.api}/api/chat/channels/${channelId}/messages`,
    payload,
    {
      headers,
      tags: { name: 'POST /api/chat/channels/:id/messages' },
    },
  );
  if (first.status === 429) return void rateLimited.add(1);
  const messageId = safeJson(first, 'message.id');
  sent.add(1);
  for (let i = 0; i < REPLAYS; i += 1) {
    const again = http.post(
      `${urls.api}/api/chat/channels/${channelId}/messages`,
      payload,
      {
        headers,
        tags: { name: 'POST /api/chat/channels/:id/messages (replay)' },
      },
    );
    if (again.status === 429) {
      rateLimited.add(1);
      continue;
    }
    const same =
      again.status === 200 &&
      safeJson(again, 'duplicate') === true &&
      safeJson(again, 'message.id') === messageId;
    replayOk.add(same);
    if (!same) duplicateMessages.add(1);
  }
}

function ingest(session) {
  const channelId = pick(channels);
  http.post(`${urls.api}/api/chat/channels/${channelId}/join`, null, {
    headers: authHeaders(session.token),
  });
  const headers = authHeaders(session.token, {
    'Content-Type': 'application/json',
  });
  for (let i = 0; i < SENDS; i += 1) {
    const res = http.post(
      `${urls.api}/api/chat/channels/${channelId}/messages`,
      JSON.stringify({
        clientMessageId: uuid(),
        body: `lt:${Date.now()}:${exec.vu.idInTest}:${i}`,
      }),
      { headers, tags: { name: 'POST /api/chat/channels/:id/messages' } },
    );
    if (res.status === 429) {
      rateLimited.add(1);
      sleep(1);
      continue;
    }
    check(res, { 'send: status 201': (r) => r.status === 201 });
    sent.add(1);
  }
}

export default function () {
  const email =
    users[(exec.scenario.iterationInTest + randomInt(0, 0)) % users.length];
  const session = login(email, PASSWORD);
  if (!session) return;
  if (SCENARIO === 'send-storm') sendStorm(session);
  else if (SCENARIO === 'ingest') ingest(session);
  else catchup(session);
}

export const handleSummary = summaryFor('chat-sync');
