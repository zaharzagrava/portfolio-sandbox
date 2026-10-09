import { execSync } from 'node:child_process';
import { API_URL } from './helpers';

/**
 * UI journeys run against the local dev stack (moon run :infra-up, :infra-setup, :dev-monolith, :dev-web), not a
 * second Docker stack: one stack keeps RAM in check. Fails fast when the API is down, then makes sure the demo
 * data exists (idempotent `seed:dev`: admin, seller + shop, catalog - all created through the real API).
 */
async function globalSetup() {
  const ok = await fetch(`${API_URL}/health/ready`).then((r) => r.ok).catch(() => false);
  if (!ok) throw new Error(`API is not ready at ${API_URL}/health/ready - start it with \`moon run :dev-monolith\``);
  execSync('pnpm --filter api seed:dev', { stdio: 'inherit', env: { ...process.env, API_URL } });
}

export default globalSetup;
