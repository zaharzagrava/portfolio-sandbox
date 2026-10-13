// Flow 8 - an event burst becomes inbox items and deliveries (S28, SC-001..SC-005).
//
//   node scripts/load-tests/seed/index.js notifications
//   k6 run -e PROFILE=load -e KAFKA_BROKERS=localhost:9092 scripts/load-tests/notifications-burst.test.js
//
// Not run in CI (specs/UNVERIFIED.md, S28 SC-001..SC-005). Needs a k6 binary built with the xk6-kafka extension
// (`xk6 build --with github.com/mostafa/xk6-kafka`): the script publishes `order.paid` envelopes (S10 shape) to topic
// `orders.events`, like the outbox relay does, and a probe user (the first seeded account) polls its inbox for the
// item of each probe order, so `notification_visible_seconds` is the time from publish to a readable inbox item.
//
// Knobs: RATE (events/s, default 115 = the average of SC-001; 2000 for the peak), DURATION, PROBE_EVERY (every Nth event
// belongs to the probe user), CHAOS=0.1 for SC-002 (resend 10 % of the events with the same event id; the duplicate
// count is then read from the delivery timeline), HANG_SMS=1 for SC-003 and PRIMARY_EMAIL_DOWN=1 for SC-004 (set on the
// backend's scripted providers, not here), MARKETING_BURST=20000 for SC-005 (adds a second scenario that publishes
// `feed.item_published` events for a followed account at that rate while the probe keeps measuring).
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import { Writer, SchemaRegistry, SCHEMA_TYPE_STRING } from 'k6/x/kafka';
import { PASSWORD, baseThresholds, urls } from './lib/config.js';
import { authHeaders, login, safeJson } from './lib/auth.js';
import { summaryFor } from './lib/summary.js';

const users = new SharedArray('notification users', () => JSON.parse(open('./data/notifications.json')).users);

const RATE = Number(__ENV.RATE || 115);
const DURATION = __ENV.DURATION || '10m';
const PROBE_EVERY = Number(__ENV.PROBE_EVERY || 200);
const CHAOS = Number(__ENV.CHAOS || 0);
const MARKETING_BURST = Number(__ENV.MARKETING_BURST || 0);
const PROBE_TIMEOUT_S = Number(__ENV.PROBE_TIMEOUT_S || 30);

const writer = new Writer({ brokers: (__ENV.KAFKA_BROKERS || 'localhost:9092').split(','), topic: __ENV.ORDERS_TOPIC || 'orders.events', autoCreateTopic: false });
const marketingWriter = new Writer({ brokers: (__ENV.KAFKA_BROKERS || 'localhost:9092').split(','), topic: __ENV.FEED_TOPIC || 'feed.events', autoCreateTopic: false });
const schemaRegistry = new SchemaRegistry();

const published = new Counter('notification_events_published');
const duplicatesSent = new Counter('notification_duplicate_events_sent');
const visibleSeconds = new Trend('notification_visible_seconds', true);
const neverVisible = new Counter('notification_never_visible');

const scenarios = {
  burst: {
    executor: 'constant-arrival-rate',
    rate: RATE,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: Math.max(20, Math.ceil(RATE / 20)),
    maxVUs: Math.max(100, Math.ceil(RATE / 5)),
    exec: 'publishOrder',
  },
};
if (MARKETING_BURST > 0)
  scenarios.marketing = {
    executor: 'constant-arrival-rate',
    rate: MARKETING_BURST,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: 200,
    maxVUs: 2000,
    exec: 'publishFeedItem',
    startTime: __ENV.MARKETING_START || '1m',
  };

export const options = {
  scenarios,
  thresholds: {
    ...baseThresholds,
    // SC-001: an inbox item is visible within 2 s at the 99th percentile.
    notification_visible_seconds: ['p(99)<2'],
    notification_never_visible: ['count==0'],
  },
};

const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

/** Event ids are UUIDv7 in the envelope contract. */
function uuid7() {
  const hex = (n) => Array.from({ length: n }, () => ((Math.random() * 16) | 0).toString(16)).join('');
  const ms = Date.now().toString(16).padStart(12, '0');
  const variant = (8 + ((Math.random() * 4) | 0)).toString(16);
  return `${ms.slice(0, 8)}-${ms.slice(8)}-7${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

function orderPaid(userId, orderId, eventId) {
  const paidAt = new Date().toISOString();
  return {
    eventId,
    type: 'order.paid',
    version: 1,
    aggregateType: 'orders',
    aggregateId: orderId,
    aggregateVersion: 2,
    occurredAt: paidAt,
    payload: {
      orderId,
      userId,
      orderVersion: 2,
      totalMinor: 12990,
      currency: 'USD',
      paymentRef: `pay_${orderId}`,
      paidAt,
      lines: [],
      shopOrders: [],
    },
  };
}

function produce(w, envelope) {
  w.produce({
    messages: [
      {
        key: schemaRegistry.serialize({ data: envelope.aggregateId, schemaType: SCHEMA_TYPE_STRING }),
        value: schemaRegistry.serialize({ data: JSON.stringify(envelope), schemaType: SCHEMA_TYPE_STRING }),
      },
    ],
  });
  published.add(1);
}

let probeSession;

export function setup() {
  const probe = users[0];
  return { probe };
}

export function publishOrder(data) {
  const n = exec.scenario.iterationInTest;
  const isProbe = n % PROBE_EVERY === 0;
  const userId = isProbe ? data.probe.id : users[n % users.length].id;
  const orderId = uuid();
  const eventId = uuid7();
  const envelope = orderPaid(userId, orderId, eventId);
  const sentAt = Date.now();
  produce(writer, envelope);
  if (CHAOS > 0 && Math.random() < CHAOS) {
    // The same event id again: exactly-once means the user still sees one item and one e-mail (SC-002).
    produce(writer, envelope);
    duplicatesSent.add(1);
  }
  if (!isProbe) return;

  probeSession = probeSession || login(data.probe.email, PASSWORD);
  if (!probeSession) return;
  const deadline = sentAt + PROBE_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    const page = http.get(`${urls.api}/api/notifications?limit=20`, {
      headers: authHeaders(probeSession.token),
      tags: { name: 'GET /api/notifications (probe)' },
    });
    const seen = (safeJson(page, 'items') || []).some((item) => item.link === `/orders/${orderId}`);
    if (seen) {
      visibleSeconds.add((Date.now() - sentAt) / 1000);
      check(page, { 'probe: item is unread': (r) => (safeJson(r, 'items') || []).find((i) => i.link === `/orders/${orderId}`).read === false });
      return;
    }
    sleep(0.1);
  }
  neverVisible.add(1);
}

export function publishFeedItem() {
  const n = exec.scenario.iterationInTest;
  const authorId = __ENV.FOLLOWED_ACCOUNT || users[0].id;
  const eventId = uuid7();
  produce(marketingWriter, {
    eventId,
    type: 'feed.item_published',
    version: 1,
    aggregateType: 'feed',
    aggregateId: authorId,
    aggregateVersion: n,
    occurredAt: new Date().toISOString(),
    payload: { itemId: uuid(), authorId, kind: 'drop_announced', createdAt: new Date().toISOString() },
  });
}

export function teardown() {
  writer.close();
  marketingWriter.close();
}

export const handleSummary = summaryFor('notifications-burst');
