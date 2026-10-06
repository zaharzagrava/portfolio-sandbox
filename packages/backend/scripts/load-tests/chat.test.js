// Flow 4 - buyers log in, get a WS ticket, and chat in seller channels.
//
//   node scripts/load-tests/seed/index.js chat
//   k6 run -e PROFILE=load scripts/load-tests/chat.test.js
//
// Per iteration: POST /api/auth/login -> POST /api/chat/ws-ticket (NestJS)
// -> open ONE WebSocket to the Rust gateway -> subscribe to a few of the
// ~100 pre-generated channels -> send a message every SEND_INTERVAL_MS for
// SESSION_SECONDS. Every message carries its send timestamp, so when the
// gateway fans our own message back to us we get the full
// send -> persist -> Redis -> fan-out round trip (`chat_message_rtt`).
import http from 'k6/http';
import ws from 'k6/ws';
import exec from 'k6/execution';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import { PASSWORD, baseThresholds, buildScenario, urls } from './lib/config.js';
import { authHeaders, login, safeJson } from './lib/auth.js';
import { pick, randomInt } from './lib/utils.js';
import { summaryFor } from './lib/summary.js';

const users = new SharedArray('chat users', () => JSON.parse(open('./data/chat.json')).users);
const channels = new SharedArray('chat channels', () => JSON.parse(open('./data/chat.json')).channels);

const SESSION_SECONDS = Number(__ENV.SESSION_SECONDS || 30);
// Gateway allows 5 sends / 3s per connection (hft-platform/src/ws.rs)
const SEND_INTERVAL_MS = Number(__ENV.SEND_INTERVAL_MS || 1000);
const CHANNELS_PER_USER = Number(__ENV.CHANNELS_PER_USER || 3);

const messagesSent = new Counter('chat_messages_sent');
const messagesReceived = new Counter('chat_messages_received');
const messageRtt = new Trend('chat_message_rtt', true);
const chatErrors = new Counter('chat_errors');
const subscribeFailures = new Counter('chat_subscribe_failures');

export const options = {
  scenarios: {
    chat: buildScenario(users.length, {
      smoke: { vus: 5, iterations: 10, maxDuration: '5m' },
      load: { vus: 2000, maxDuration: '60m' },
      stress: { vus: 10000, maxDuration: '60m' },
    }),
  },
  thresholds: {
    ...baseThresholds,
    'http_req_duration{name:POST /api/chat/ws-ticket}': ['p(95)<500'],
    ws_connecting: ['p(95)<1000'],
    chat_message_rtt: ['p(95)<300', 'p(99)<1000'],
    chat_errors: ['count<100'],
  },
};

const BODY_RE = /^lt:(\d+):/;
const LOREM = [
  'is this still available?', 'can you ship to Berlin?', 'what is the lowest price?',
  'does it come with a warranty?', 'any discount for two?', 'thanks, ordering now',
  'is the color accurate in the photos?', 'how long does delivery take?',
];

function pickChannels(count) {
  const picked = new Set();
  while (picked.size < Math.min(count, channels.length)) {
    picked.add(channels[randomInt(0, channels.length - 1)]);
  }
  return [...picked];
}

export default function () {
  const email = users[exec.scenario.iterationInTest % users.length];

  const session = login(email, PASSWORD);
  if (!session) return;

  const ticketRes = http.post(`${urls.api}/api/chat/ws-ticket`, null, {
    headers: authHeaders(session.token),
    tags: { name: 'POST /api/chat/ws-ticket' },
  });
  const ticketOk = check(ticketRes, {
    'ticket: status 201': (r) => r.status === 201,
    'ticket: has ticket': (r) => Boolean(safeJson(r, 'ticket')),
  });
  if (!ticketOk) return;

  const wsBase = urls.chatWs || safeJson(ticketRes, 'wsUrl');
  const wantedChannels = pickChannels(CHANNELS_PER_USER);
  const subscribed = [];
  const myUserId = session.user.id;
  let seq = 0;

  const res = ws.connect(
    `${wsBase}?ticket=${encodeURIComponent(safeJson(ticketRes, 'ticket'))}`,
    { tags: { name: 'WS /ws' } },
    (socket) => {
      socket.on('open', () => {
        for (const channelId of wantedChannels) {
          socket.send(JSON.stringify({ op: 'subscribe', channelId }));
        }
      });

      socket.on('message', (raw) => {
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          chatErrors.add(1, { code: 'bad_frame' });
          return;
        }

        switch (event.type) {
          case 'subscribed':
            subscribed.push(event.channelId);
            break;
          case 'message': {
            messagesReceived.add(1);
            if (event.message && event.message.authorId === myUserId) {
              const match = BODY_RE.exec(event.message.body || '');
              if (match) messageRtt.add(Date.now() - Number(match[1]));
            }
            break;
          }
          case 'error':
            chatErrors.add(1, { code: event.code || 'unknown' });
            break;
          case 'banned':
            chatErrors.add(1, { code: 'banned' });
            break;
          default:
            break; // ready, typing, pong, message_deleted, ...
        }
      });

      socket.setInterval(() => {
        if (!subscribed.length) return;
        const channelId = pick(subscribed);

        if (Math.random() < 0.15) {
          socket.send(JSON.stringify({ op: 'typing', channelId }));
        }

        seq += 1;
        socket.send(
          JSON.stringify({
            op: 'send',
            channelId,
            body: `lt:${Date.now()}:${exec.vu.idInTest}:${seq} ${pick(LOREM)}`,
          }),
        );
        messagesSent.add(1);
      }, SEND_INTERVAL_MS);

      socket.setTimeout(() => {
        if (subscribed.length < wantedChannels.length) {
          subscribeFailures.add(wantedChannels.length - subscribed.length);
        }
        socket.close();
      }, SESSION_SECONDS * 1000);
    },
  );

  check(res, { 'ws: status 101': (r) => r && r.status === 101 });
}

export const handleSummary = summaryFor('chat');
