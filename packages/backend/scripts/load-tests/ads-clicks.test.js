// SD-32 / S36 - sponsored listings: click redirect load and the capacity proof (SC-002, SC-008, AS-83).
//
//   ADS_CLICK_SECRET=<the app's secret> k6 run -e PROFILE=load -e CAMPAIGN_ID=<uuid> -e SHOP_ID=<uuid> -e PRODUCT_ID=<uuid> \
//     scripts/load-tests/ads-clicks.test.js
//
// Every iteration mints a click token exactly like the serving endpoint does (`v1.<kid>.<payload>.<signature>`, HMAC-SHA256
// with the subkeys of `domain/click-token.ts`) and follows it without following the redirect. 10% of the iterations replay
// an earlier token (a duplicate), 5% carry a forged signature (invalid); the rest are fresh impressions. The generator
// counts what it sent (`ads_clicks_distinct_valid`) so the operator can compare it with the store afterwards:
//
//   SELECT uniqExact(click_id) FROM ad_clicks_log WHERE valid = 1 AND campaign_id = '<CAMPAIGN_ID>'   -- equals the ground truth
//   SELECT sum(clicks) FROM ad_click_minute_v2 FINAL WHERE campaign_id = '<CAMPAIGN_ID>'              -- equals it too, after the aggregator caught up
//   kafka-consumer-groups: no partition of `ads.clicks` holds more than 15% of the campaign's records (10 salted keys, 64 partitions)
//
// SLOs: 95% of redirects within 200 ms (SC-002); 50,000 clicks/s sustained (SC-008). Run it a second time with the broker
// stopped: every click must still answer 302 (`ads_redirect_not_302` stays 0). This is an ops artifact (specs/UNVERIFIED.md):
// the automated suite proves correctness (AS-26 to AS-49), not the rate. Note the spam filter: one address is valid for 20
// clicks a minute, so a real run spreads the load over many source addresses (k6 `--local-ips` or a load balancer).
import http from 'k6/http';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { urls, PROFILE } from './lib/config.js';

const SECRET = __ENV.ADS_CLICK_SECRET;
const CAMPAIGN_ID = __ENV.CAMPAIGN_ID;
const SHOP_ID = __ENV.SHOP_ID;
const PRODUCT_ID = __ENV.PRODUCT_ID;
if (!SECRET || !CAMPAIGN_ID || !SHOP_ID || !PRODUCT_ID)
  throw new Error('set ADS_CLICK_SECRET, CAMPAIGN_ID, SHOP_ID and PRODUCT_ID');

const distinctValid = new Counter('ads_clicks_distinct_valid');
const duplicates = new Counter('ads_clicks_duplicates');
const forged = new Counter('ads_clicks_forged');
const notRedirect = new Counter('ads_redirect_not_302');

const rate = { smoke: 20, load: 50000, stress: 80000 }[PROFILE] || 20;

export const options = {
  scenarios: {
    clicks: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: Math.min(rate, 5000),
      maxVUs: Math.min(rate * 2, 50000),
    },
  },
  thresholds: {
    'http_req_duration{name:GET /ads/click}': ['p(95)<200'],
    ads_redirect_not_302: ['count==0'],
  },
};

const subkey = (purpose) => crypto.hmac('sha256', SECRET, `ads:${purpose}`, 'binary');
const KID = crypto.hmac('sha256', SECRET, 'ads:kid', 'hex').slice(0, 8);
const SIGNING_KEY = subkey('token');
const VIEWER_KEY = subkey('viewer');
const b64url = (s) => encoding.b64encode(s, 'rawurl');
const uuid = () => {
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-7${h().slice(1)}-8${h().slice(1)}-${h()}${h()}${h()}`;
};

function mint() {
  const viewer = crypto.hmac('sha256', VIEWER_KEY, `anon:${uuid()}`, 'hex').slice(0, 32);
  const claims = { i: uuid(), c: CAMPAIGN_ID, s: SHOP_ID, p: PRODUCT_ID, e: Date.now() + 25 * 60 * 1000, v: viewer };
  const signed = `v1.${KID}.${b64url(JSON.stringify(claims))}`;
  const signature = b64url(crypto.hmac('sha256', SIGNING_KEY, signed, 'binary'));
  return `${signed}.${signature}`;
}

const recent = [];

export default function () {
  const roll = Math.random();
  let token;
  if (roll < 0.1 && recent.length > 0) {
    token = recent[Math.floor(Math.random() * recent.length)];
    duplicates.add(1);
  } else if (roll < 0.15) {
    token = `${mint().slice(0, -4)}AAAA`;
    forged.add(1);
  } else {
    token = mint();
    distinctValid.add(1);
    if (recent.length < 1000) recent.push(token);
  }
  const res = http.get(`${urls.api}/api/ads/click/${token}`, { redirects: 0, tags: { name: 'GET /ads/click' } });
  if (res.status !== 302) notRedirect.add(1);
  check(res, { 'redirect 302': (r) => r.status === 302 });
}
