// Shared k6 configuration. Every value can be overridden with -e KEY=value.

export const urls = {
  // NestJS core app (auth, search, stats, payment reads, chat tickets)
  api: __ENV.API_URL || 'http://localhost:8000',
  // Cloudflare edge worker (`wrangler dev`) - the only payment write ingress
  edge: __ENV.EDGE_URL || 'http://localhost:8787',
  // Search can go straight to core or through the edge's GET proxy
  search: __ENV.SEARCH_URL || __ENV.API_URL || 'http://localhost:8000',
  // Rust chat gateway; falls back to the wsUrl returned with the WS ticket
  chatWs: __ENV.CHAT_WS_URL || '',
};

// Must match LOADTEST_PASSWORD used by scripts/load-tests/seed
export const PASSWORD = __ENV.LOADTEST_PASSWORD || 'LoadTest-Passw0rd!';

export const PROFILE = __ENV.PROFILE || 'smoke';

/**
 * Each flow is one `shared-iterations` scenario: one iteration = one seeded
 * account (login + that account's work), so a full `load` run walks through
 * every seeded user exactly once. `vus` is the concurrency knob.
 */
export function buildScenario(accountCount, profiles) {
  const profile = profiles[PROFILE];
  if (!profile) {
    throw new Error(`Unknown PROFILE "${PROFILE}" (expected: ${Object.keys(profiles).join(', ')})`);
  }

  const iterations = Number(__ENV.ITERATIONS || profile.iterations || accountCount);

  return {
    executor: 'shared-iterations',
    vus: Number(__ENV.VUS || profile.vus),
    iterations,
    maxDuration: __ENV.MAX_DURATION || profile.maxDuration,
  };
}

export const baseThresholds = {
  checks: ['rate>0.99'],
  'http_req_duration{name:POST /api/auth/login}': ['p(95)<1500'],
  auth_login_failures: ['count<10'],
};
