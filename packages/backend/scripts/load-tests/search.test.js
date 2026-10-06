// Flow 2 - buyers log in and search the catalog (Elasticsearch).
//
//   node scripts/load-tests/seed/index.js search
//   k6 run -e PROFILE=load scripts/load-tests/search.test.js
//
// The query mix exercises every search feature: plain fuzzy/BM25 queries
// (30% of seeded terms carry a typo), facets, range/term filters, prefix
// autocomplete and semantic k-NN. Set SEARCH_URL=http://localhost:8787 to
// route through the edge's GET proxy instead of hitting core directly.
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { PASSWORD, baseThresholds, buildScenario, urls } from './lib/config.js';
import { authHeaders, login, safeJson } from './lib/auth.js';
import { pick, randomBetween, randomInt, toQueryString } from './lib/utils.js';
import { summaryFor } from './lib/summary.js';

const users = new SharedArray('search users', () => JSON.parse(open('./data/search.json')).users);
const vocab = new SharedArray('search vocab', () => {
  const { queries, categories, brands } = JSON.parse(open('./data/search.json'));
  return [{ queries, categories, brands }];
})[0];

const SEARCHES_PER_USER = Number(__ENV.SEARCHES_PER_USER || 5);

const emptyResults = new Counter('search_empty_results');

export const options = {
  scenarios: {
    search: buildScenario(users.length, {
      smoke: { vus: 5, iterations: 20, maxDuration: '3m' },
      load: { vus: 500, maxDuration: '45m' },
      stress: { vus: 2000, maxDuration: '45m' },
    }),
  },
  thresholds: {
    ...baseThresholds,
    'http_req_duration{name:GET /api/products/search}': ['p(95)<400', 'p(99)<1000'],
    'http_req_failed{name:GET /api/products/search}': ['rate<0.01'],
    'http_req_duration{kind:facets}': ['p(95)<600'],
  },
};

function buildSearch() {
  const params = { q: pick(vocab.queries) };
  const roll = Math.random();
  let kind = 'plain';

  if (roll < 0.2) {
    kind = 'facets';
    params.facets = 'true';
  } else if (roll < 0.35) {
    kind = 'range';
    const priceMin = randomInt(0, 20000);
    params.category = pick(vocab.categories);
    params.priceMin = priceMin;
    params.priceMax = priceMin + randomInt(5000, 100000);
  } else if (roll < 0.45) {
    kind = 'brand';
    params.brand = pick(vocab.brands);
    params.ratingMin = pick([3, 3.5, 4, 4.5]);
  } else if (roll < 0.5) {
    kind = 'semantic';
    params.semantic = 'true';
  }

  // Occasional pagination
  if (Math.random() < 0.15) params.from = 20;

  return { query: toQueryString(params), kind };
}

export default function () {
  const email = users[exec.scenario.iterationInTest % users.length];

  const session = login(email, PASSWORD);
  if (!session) return;

  for (let i = 0; i < SEARCHES_PER_USER; i++) {
    const { query, kind } = buildSearch();

    const res = http.get(`${urls.search}/api/products/search?${query}`, {
      headers: authHeaders(session.token),
      tags: { name: 'GET /api/products/search', kind },
    });

    check(res, {
      'search: status 200': (r) => r.status === 200,
      'search: has hits array': (r) => Array.isArray(safeJson(r, 'hits')),
    });

    if (res.status === 200 && safeJson(res, 'total') === 0) {
      emptyResults.add(1, { kind });
    }

    sleep(randomBetween(0.3, 1.2));
  }
}

export const handleSummary = summaryFor('search');
