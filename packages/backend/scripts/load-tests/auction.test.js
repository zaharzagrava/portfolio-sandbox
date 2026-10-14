// S21 - a hot auction: 200 bidders and 100 bids/s on ONE auction, 1,000 viewers on its page, 1,000 randomized retries.
//
//   node scripts/load-tests/seed/index.js payment       (seeded bidders)
//   k6 run -e PROFILE=load -e SELLER_EMAIL=<owner> -e SHOP_ID=<uuid> -e PRODUCT_ID=<uuid> \
//          scripts/load-tests/auction.test.js
//
// setup() schedules the auction through the seller route (`POST /api/shops/:shopId/auctions`, start in 2 minutes, one
// hour long, an Idempotency-Key) and waits until the public view says `OPEN`. Three scenarios then run against it:
//   bidding   100 bids/s, each from one of the seeded bidders, a unique Idempotency-Key, an increasing maximum
//   viewers   1,000 virtual users reading the public view (a second of cache, one durable read per second at most)
//   retries   1,000 bids each sent twice with the SAME key, which must answer the same body (`Idempotency-Replayed`)
//
// Pass criteria (thresholds): bids p95 < 300 ms and p99 < 800 ms (SC-002); views p99 < 150 ms (SC-011); no duplicate
// from a retry (SC-009: `auction_duplicate_bids == 0`); the price sequence read back from the public history never
// decreases and its sequences are gapless (`auction_history_violations == 0`, computed in teardown).
// The result of a run belongs in specs/UNVERIFIED.md (S21 SC-001, SC-002, SC-009, SC-011); this script is not run by
// the automated suite.
import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import { urls, PASSWORD } from './lib/config.js';
import { uuidv7 } from './lib/utils.js';

const users = new SharedArray('bidders', () =>
  JSON.parse(open('./data/payment.json')).users.map((u) => u.email),
);
const SELLER_EMAIL = __ENV.SELLER_EMAIL;
const SHOP_ID = __ENV.SHOP_ID;
const PRODUCT_ID = __ENV.PRODUCT_ID;
const BIDDERS = Number(__ENV.BIDDERS || 200);
const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || '2m';

const accepted = new Counter('auction_bids_accepted');
const rejected = new Counter('auction_bids_rejected');
const limited = new Counter('auction_bids_rate_limited');
const duplicateBids = new Counter('auction_duplicate_bids');
const historyViolations = new Counter('auction_history_violations');
const bidMs = new Trend('auction_bid_ms', true);
const viewMs = new Trend('auction_view_ms', true);

export const options = {
  scenarios: {
    bidding: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 200,
      maxVUs: 1000,
      exec: 'bid',
      startTime: '10s',
    },
    viewers: {
      executor: 'constant-vus',
      vus: Number(__ENV.VIEWERS || 1000),
      duration: DURATION,
      exec: 'view',
      startTime: '10s',
    },
    retries: {
      executor: 'shared-iterations',
      vus: 50,
      iterations: Number(__ENV.RETRIES || 1000),
      maxDuration: '10m',
      exec: 'retry',
      startTime: '10s',
    },
  },
  thresholds: {
    auction_bid_ms: ['p(95)<300', 'p(99)<800'],
    auction_view_ms: ['p(99)<150'],
    auction_duplicate_bids: ['count==0'],
    auction_history_violations: ['count==0'],
  },
};

const json = { 'Content-Type': 'application/json' };
const tokens = {};

function login(email) {
  if (tokens[email]) return tokens[email];
  const res = http.post(
    `${urls.api}/api/auth/login`,
    JSON.stringify({ email, password: PASSWORD }),
    { headers: json, tags: { name: 'POST /api/auth/login' } },
  );
  if (res.status !== 200) return null;
  tokens[email] = { ...json, Authorization: `Bearer ${res.json('accessToken.token')}` };
  return tokens[email];
}

export function setup() {
  const seller = login(SELLER_EMAIL);
  if (!seller) throw new Error('seller login failed');
  const startsAt = new Date(Date.now() + 2 * 60_000);
  const created = http.post(
    `${urls.api}/api/shops/${SHOP_ID}/auctions`,
    JSON.stringify({
      productId: PRODUCT_ID,
      title: 'Load test auction',
      startingPriceMinor: 1000,
      minIncrementMinor: 50,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
    }),
    { headers: { ...seller, 'Idempotency-Key': `load-${uuidv7()}` } },
  );
  if (created.status !== 201)
    throw new Error(`auction not created: ${created.status} ${created.body}`);
  const auctionId = created.json('id');
  for (let i = 0; i < 400; i += 1) {
    if (http.get(`${urls.api}/api/auctions/${auctionId}`).json('status') === 'OPEN')
      return { auctionId };
    sleep(1);
  }
  throw new Error('the auction did not open');
}

function place(auctionId, email, maxAmountMinor, key) {
  const headers = login(email);
  if (!headers) return null;
  return http.post(
    `${urls.api}/api/auctions/${auctionId}/bids`,
    JSON.stringify({ maxAmountMinor }),
    { headers: { ...headers, 'Idempotency-Key': key }, tags: { name: 'POST /bids' } },
  );
}

export function bid({ auctionId }) {
  const email = users[(__VU * 7 + __ITER) % Math.min(BIDDERS, users.length)];
  const view = http.get(`${urls.api}/api/auctions/${auctionId}`, { tags: { name: 'GET /auction' } });
  const next = (view.json('minimumNextMaxMinor') || 1000) + Math.floor(Math.random() * 500);
  const res = place(auctionId, email, next, `bid-${uuidv7()}`);
  if (!res) return;
  bidMs.add(res.timings.duration);
  if (res.status === 200) accepted.add(1);
  else if (res.status === 429) limited.add(1);
  else rejected.add(1); // 422 bid_too_low after a race is a normal answer
}

export function view({ auctionId }) {
  const res = http.get(`${urls.api}/api/auctions/${auctionId}`, { tags: { name: 'GET /auction' } });
  viewMs.add(res.timings.duration);
  sleep(1 + Math.random());
}

export function retry({ auctionId }) {
  const email = users[(__VU + __ITER) % Math.min(BIDDERS, users.length)];
  const key = `retry-${uuidv7()}`;
  const amount = 5000 + Math.floor(Math.random() * 1_000_000);
  const first = place(auctionId, email, amount, key);
  const again = place(auctionId, email, amount, key);
  if (!first || !again) return;
  // the same key answers the same status; a 200 answers byte for byte the same body
  if (first.status === 200 && (again.status !== 200 || again.body !== first.body))
    duplicateBids.add(1);
}

export function teardown({ auctionId }) {
  // the public history: price-changing bids newest first; price never decreases and sequences are unique and falling
  let cursor = null;
  let previous = null;
  for (let page = 0; page < 200; page += 1) {
    const res = http.get(
      `${urls.api}/api/auctions/${auctionId}/bids?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
    );
    if (res.status !== 200) break;
    for (const item of res.json('items')) {
      if (previous && (item.priceMinor > previous.priceMinor || item.sequence >= previous.sequence))
        historyViolations.add(1);
      previous = item;
    }
    cursor = res.json('nextCursor');
    if (!cursor) break;
  }
}
