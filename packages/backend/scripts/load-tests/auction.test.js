// SD-22 - a hot auction: thousands of bidders, 2k bids/s on ONE auction.
//
//   k6 run -e AUCTION_ID=<uuid> -e PROFILE=load scripts/load-tests/auction.test.js
//
// Every bid is one Lua EVAL on the auction's Redis hash (+ XADD to its bid log);
// Postgres is fed by the bid relay in batches. Thresholds: bid p99 < 50 ms.
// Afterwards verify the price sequence in Postgres is monotonic:
//   SELECT count(*) FROM (SELECT "priceAfter" < lag("priceAfter") OVER (ORDER BY version) AS dropped
//                         FROM "Bid" WHERE "auctionId" = '<id>') t WHERE dropped;   -- must be 0
import http from 'k6/http';
import { SharedArray } from 'k6/data';
import { urls, PASSWORD } from './lib/config.js';

const users = new SharedArray('bidders', () => JSON.parse(open('./data/payment.json')).users.map((u) => u.email));
const AUCTION_ID = __ENV.AUCTION_ID;

export const options = {
  scenarios: {
    bidding: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 2000),
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: 500,
      maxVUs: 3000,
    },
  },
  thresholds: {
    'http_req_duration{name:POST /bids}': ['p(99)<50'],
    'http_req_failed{name:POST /bids}': ['rate<0.01'],
  },
};

const tokens = {};

export default function () {
  const email = users[__VU % users.length];
  if (!tokens[email]) {
    const login = http.post(`${urls.api}/api/auth/login`, JSON.stringify({ email, password: PASSWORD }), { headers: { 'Content-Type': 'application/json' } });
    if (login.status !== 200) return;
    tokens[email] = login.json('accessToken.token');
  }
  const current = http.get(`${urls.api}/api/auctions/${AUCTION_ID}`, { tags: { name: 'GET /auction' } }).json('price') || 0;
  http.post(`${urls.api}/api/auctions/${AUCTION_ID}/bids`, JSON.stringify({ maxAmount: current + 5 + Math.floor(Math.random() * 500) }), {
    headers: { Authorization: `Bearer ${tokens[email]}`, 'Content-Type': 'application/json' },
    tags: { name: 'POST /bids' },
  });
}
