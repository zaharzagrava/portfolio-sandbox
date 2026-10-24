import { execSync } from 'node:child_process';
import { API_URL, SEED, closeSharedRedis, resetRateLimits } from './helpers';
import { checkSeeds } from './seeds';

const WEB_URL = 'http://localhost:3000';

/** True when the demo data is already there (both demo accounts sign in and the demo product is searchable): `seed:dev` would change nothing. */
async function demoDataPresent(): Promise<boolean> {
  try {
    const login = (email: string) =>
      fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: SEED.password }),
      }).then((r) => r.status === 200);
    const [seller, admin, search] = await Promise.all([
      login(SEED.seller),
      login(SEED.admin),
      fetch(`${API_URL}/api/products/search?q=${encodeURIComponent(SEED.product)}`).then(async (r) =>
        r.ok ? ((await r.json()) as { items: { title: string }[] }).items.some((item) => item.title === SEED.product) : false,
      ),
    ]);
    return seller && admin && search;
  } catch {
    return false;
  }
}

/**
 * The dev server compiles a page on its first visit (several seconds each, and the first test of each worker used to pay it inside its
 * own time limit). Fetching the public pages once, a few at a time, before any test starts moves that cost out of the tests. Only
 * a warm-up: every answer is ignored, nothing here can fail the run.
 */
async function warmRoutes() {
  const routes = ['/', '/login', '/register', '/forgot-password', '/reset-password', '/login/mfa', '/search', '/cart', '/chat', '/terms', '/privacy', '/developers/docs'];
  const queue = [...routes];
  const worker = async () => {
    for (let route = queue.shift(); route; route = queue.shift()) {
      await fetch(`${WEB_URL}${route}`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

/**
 * UI journeys run against the local dev stack (moon run :infra-up, :infra-setup, :dev-monolith, :dev-web), not a
 * second Docker stack: one stack keeps RAM in check. Fails fast when the API is down, then makes sure the demo
 * data exists (idempotent `seed:dev`: admin, seller + shop, catalog - all created through the real API).
 * `seed:dev` is skipped when the demo data is already there; PW_FORCE_SEED=1 runs it anyway.
 */
async function globalSetup() {
  const ok = await fetch(`${API_URL}/health/ready`).then((r) => r.ok).catch(() => false);
  if (!ok) throw new Error(`API is not ready at ${API_URL}/health/ready - start it with \`moon run :dev-monolith\``);
  const warming = warmRoutes(); // runs next to the seed and the Redis clean-up
  await resetRateLimits();
  await closeSharedRedis();
  if (process.env.PW_FORCE_SEED === '1' || !(await demoDataPresent())) {
    try {
      execSync('pnpm --filter api seed:dev', { stdio: 'inherit', env: { ...process.env, API_URL } });
    } catch {
      // Specs that need no demo data (W07's shell, headers) still run; the ones that do fail with their own message.
      console.error('WARNING: seed:dev failed - specs that need the demo admin/seller/catalog will fail.');
    }
  }
  // W02 B-6: fail fast, naming the seed, when the stack cannot offer what a journey builds on.
  await checkSeeds();
  await warming;
}

export default globalSetup;
