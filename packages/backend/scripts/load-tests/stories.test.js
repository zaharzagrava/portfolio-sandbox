// SD-05 / S27 - brand stories: the public read at the origin (read-model hits and misses) and the publish path.
//
//   node scripts/load-tests/seed/index.js payment                         (a seeded seller who owns a shop)
//   k6 run -e PROFILE=load -e SHOP_ID=<uuid> -e SHOP_SLUG=<slug> -e SELLER_EMAIL=<email> scripts/load-tests/stories.test.js
//
// Setup publishes STORIES stories (default 200, two locales) as the seller and waits for the shop copy to see the shop
// (the projector keeps `StoryShop`). Then:
//   - reads: constant arrival rate of public reads, Zipf-like over the stories, locale in the path, with `If-None-Match`
//     on a share of them (304 expected); `MISS_SHARE` of them name a story that exists only in the durable store because
//     its origin entry was never warmed (the cold-key path: one durable read per key per minute).
//   - publishes: a trickle of republishes, each one clearing the origin entry of its story.
// SLOs (S27 SC-003): the origin, answering from its read model, sustains 2,000 requests per second with p99 below 50 ms.
// This is an ops artifact (specs/UNVERIFIED.md): the automated suite proves correctness (AS-25 to AS-31), not the rate.
// The CDN's 99% hit ratio is measured at the CDN, not here.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { urls, PASSWORD, PROFILE } from './lib/config.js';

const SHOP_ID = __ENV.SHOP_ID;
const SHOP_SLUG = __ENV.SHOP_SLUG;
const SELLER_EMAIL = __ENV.SELLER_EMAIL;
const STORIES = Number(__ENV.STORIES || 200);
const MISS_SHARE = Number(__ENV.MISS_SHARE || 0.02);
const NOT_MODIFIED_SHARE = Number(__ENV.NOT_MODIFIED_SHARE || 0.3);
const readRate = { smoke: 20, load: 2000, stress: 4000 }[PROFILE] || 20;
const publishRate = { smoke: 1, load: 5, stress: 10 }[PROFILE] || 1;

const served = new Counter('story_reads_served');
const notModified = new Counter('story_reads_not_modified');
const publishes = new Counter('story_publishes');

export const options = {
  scenarios: {
    reads: {
      executor: 'constant-arrival-rate',
      rate: readRate,
      timeUnit: '1s',
      duration: __ENV.READ_DURATION || '2m',
      preAllocatedVUs: Math.min(readRate, 1000),
      maxVUs: Math.min(readRate * 2, 5000),
      exec: 'read',
    },
    publish: {
      executor: 'constant-arrival-rate',
      rate: publishRate,
      timeUnit: '1s',
      duration: __ENV.READ_DURATION || '2m',
      preAllocatedVUs: 5,
      maxVUs: 50,
      exec: 'republish',
    },
  },
  thresholds: {
    'http_req_duration{name:GET story}': ['p(99)<50'],
    'http_req_failed{name:GET story}': ['rate<0.001'],
    'http_req_duration{name:POST publish}': ['p(99)<500'],
  },
};

const json = { 'Content-Type': 'application/json' };
const login = () => {
  const res = http.post(`${urls.api}/api/auth/login`, JSON.stringify({ email: SELLER_EMAIL, password: PASSWORD }), {
    headers: json,
    tags: { name: 'POST /api/auth/login' },
  });
  return res.status === 200 ? res.json('accessToken.token') : null;
};
const auth = (token, extra = {}) => ({ headers: { ...json, Authorization: `Bearer ${token}`, ...extra } });
const shopPath = `${urls.api}/api/shops/${SHOP_ID}/stories`;

export function setup() {
  if (!SHOP_ID || !SHOP_SLUG || !SELLER_EMAIL) throw new Error('set SHOP_ID, SHOP_SLUG and SELLER_EMAIL');
  const token = login();
  if (!token) throw new Error('seller login failed');
  const stories = [];
  const stamp = Date.now();
  for (let i = 0; i < STORIES; i++) {
    const slug = `load-${stamp}-${i}`;
    const created = http.post(shopPath, JSON.stringify({ slug }), { ...auth(token), tags: { name: 'setup create' } });
    if (created.status !== 201) continue;
    const id = created.json('id');
    for (const locale of ['en', 'uk']) {
      http.put(
        `${shopPath}/${id}/drafts/${locale}`,
        JSON.stringify({
          title: `Load story ${i} (${locale})`,
          blocks: [
            { type: 'heading', level: 2, text: 'Design' },
            { type: 'richText', html: '<p>Load test <strong>content</strong></p>' },
          ],
          expectedRevision: 0,
        }),
        { ...auth(token), tags: { name: 'setup draft' } },
      );
    }
    const published = http.post(`${shopPath}/${id}/publish`, JSON.stringify({ expectedVersion: 0 }), {
      ...auth(token, { 'Idempotency-Key': `load-setup-${stamp}-${i}` }),
      tags: { name: 'setup publish' },
    });
    if (published.status === 200) stories.push({ id, slug, version: 1 });
    if (i % 20 === 19) sleep(1); // stay under the 120 writes per minute per shop of the staff routes
  }
  return { stories, token };
}

/** Zipf-like: rank r is picked with weight 1/r, by cubing a uniform number. */
const pick = (items) => items[Math.floor(Math.pow(Math.random(), 3) * items.length)];

export function read(data) {
  const story = pick(data.stories);
  const cold = Math.random() < MISS_SHARE;
  const locale = cold ? 'fr' : Math.random() < 0.5 ? 'en' : 'uk';
  const url = `${urls.api}/api/stories/${SHOP_SLUG}/${story.slug}/${locale}`;
  const params = { tags: { name: 'GET story' } };
  if (Math.random() < NOT_MODIFIED_SHARE) params.headers = { 'If-None-Match': `"${story.id}-v${story.version}-${locale === 'fr' ? 'en' : locale}"` };
  const res = http.get(url, params);
  if (res.status === 304) notModified.add(1);
  else served.add(1);
  check(res, {
    'served or not modified': (r) => r.status === 200 || r.status === 304,
    'edge cache contract': (r) => r.status !== 200 || r.headers['Cache-Control'] === 'public, s-maxage=300, stale-while-revalidate=86400',
  });
}

export function republish(data) {
  const story = pick(data.stories);
  // read the draft revision, change the title, publish the next version
  const detail = http.get(`${shopPath}/${story.id}`, { ...auth(data.token), tags: { name: 'GET detail' } });
  if (detail.status !== 200) return;
  const draft = detail.json('drafts').find((d) => d.locale === 'en');
  const saved = http.put(
    `${shopPath}/${story.id}/drafts/en`,
    JSON.stringify({ title: `Republished ${Date.now()}`, blocks: draft.blocks, expectedRevision: draft.revision }),
    { ...auth(data.token), tags: { name: 'PUT draft' } },
  );
  if (saved.status !== 200) return;
  const res = http.post(`${shopPath}/${story.id}/publish`, JSON.stringify({ expectedVersion: detail.json('publishedVersion') }), {
    ...auth(data.token, { 'Idempotency-Key': `load-${__VU}-${__ITER}-${Date.now()}` }),
    tags: { name: 'POST publish' },
  });
  if (res.status === 200) {
    publishes.add(1);
    story.version = res.json('version');
  }
  check(res, { 'publish accepted or refused cleanly': (r) => [200, 409, 422, 429, 503].includes(r.status) });
}
