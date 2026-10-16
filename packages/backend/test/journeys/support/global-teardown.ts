/**
 * Runs once after every journey file, whatever happened (L-013, L-016): all journey consumers resumed, the clock real.
 * Plain `fetch` on purpose: jest loads this file outside the test module system, so it cannot import the ESM contracts
 * package that `control-surface.ts` uses. It never fails the run because there was nothing to restore, and it never
 * throws when the stack is down.
 */
const GROUPS = [
  'payments-order-copy',
  'orders-payment-results',
  'ledger-settlement',
  'ledger-balances',
  'notification-router',
  'statements-facts',
];

export default async function globalTeardown(): Promise<void> {
  const api = process.env.API_URL ?? 'http://localhost:8000';
  try {
    const login = await fetch(`${api}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: process.env.JOURNEY_ADMIN_EMAIL ?? 'admin@marketplace.local',
        password: process.env.JOURNEY_ADMIN_PASSWORD ?? 'Demo-Seed-Pw-7491!',
      }),
    });
    if (!login.ok) throw new Error(`admin login ${login.status}`);
    const token = ((await login.json()) as { accessToken: { token: string } })
      .accessToken.token;
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const failures: string[] = [];
    for (const group of GROUPS) {
      const resumed = await fetch(
        `${api}/api/admin/consumers/${group}/resume`,
        { method: 'POST', headers },
      );
      if (!resumed.ok) failures.push(`resume ${group}: ${resumed.status}`);
    }
    const clock = await fetch(`${api}/api/admin/clock`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ mode: 'real' }),
    });
    if (!clock.ok && clock.status !== 404)
      failures.push(`clock reset: ${clock.status}`);
    if (failures.length)
      console.error(`global teardown: ${failures.join('; ')}`);
  } catch (error) {
    console.error(
      `global teardown: could not restore the stack (${(error as Error).message})`,
    );
  }
}
