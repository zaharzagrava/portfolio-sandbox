/**
 * SC-006 (S41): registration p95 under 500 ms (the host name lookup is not part of the target; use a literal-free
 * public host that resolves quickly) and a 365-day history read p95 under 300 ms. Not a CI gate.
 *
 *   API_URL=http://localhost:3000 TOKEN='<access token>' SHOP_ID=<shop> PRODUCT_IDS=<id,id,...> \
 *   WATCH_ID=<a watch whose target holds ~365 days of history> HOST=example.com \
 *     TS_NODE_TRANSPILE_ONLY=1 node -r ts-node/register scripts/load-tests/competitor-api.ts [registrations=200] [reads=500]
 *
 * Needs a running core app, a shop with a large `maxCompetitorWatches`, products to spread the watches over (at most 5
 * watches per product) and a watch with seeded history. Registrations use distinct URLs of `HOST` and do not fetch.
 */
const [registrationsArg, readsArg] = process.argv.slice(2);
const REGISTRATIONS = Number(registrationsArg ?? 200);
const READS = Number(readsArg ?? 500);
const API = process.env.API_URL ?? 'http://localhost:3000';
const TOKEN = process.env.TOKEN ?? '';
const SHOP = process.env.SHOP_ID ?? '';
const WATCH = process.env.WATCH_ID ?? '';
const HOST = process.env.HOST ?? 'example.com';
const PRODUCTS = (process.env.PRODUCT_IDS ?? '').split(',').filter(Boolean);

const headers = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
};
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(values.length * 0.95) - 1)
  ] ?? 0;

async function timed(call: () => Promise<Response>, ok: number[]) {
  const started = performance.now();
  const res = await call();
  const ms = performance.now() - started;
  await res.arrayBuffer();
  return { ms, ok: ok.includes(res.status) };
}

async function main() {
  if (!TOKEN || !SHOP || PRODUCTS.length === 0) {
    console.error('TOKEN, SHOP_ID and PRODUCT_IDS are required');
    process.exit(2);
  }
  const registration: number[] = [];
  let failures = 0;
  for (let i = 0; i < REGISTRATIONS; i++) {
    const result = await timed(
      () =>
        fetch(`${API}/api/shops/${SHOP}/competitors`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            productId: PRODUCTS[Math.floor(i / 5) % PRODUCTS.length],
            url: `https://${HOST}/load/${Date.now()}-${i}`,
          }),
        }),
      [200, 201],
    );
    registration.push(result.ms);
    if (!result.ok) failures++;
  }
  const history: number[] = [];
  if (WATCH)
    for (let i = 0; i < READS; i++) {
      const result = await timed(
        () =>
          fetch(
            `${API}/api/shops/${SHOP}/competitors/${WATCH}/prices?days=365`,
            { headers },
          ),
        [200],
      );
      history.push(result.ms);
      if (!result.ok) failures++;
    }
  const report = {
    registrations: REGISTRATIONS,
    registrationP95Ms: Math.round(p95(registration)),
    registrationTargetMs: 500,
    historyReads: history.length,
    historyP95Ms: Math.round(p95(history)),
    historyTargetMs: 300,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (
    failures > 0 ||
    report.registrationP95Ms >= 500 ||
    (history.length > 0 && report.historyP95Ms >= 300)
  )
    process.exitCode = 1;
}

void main();
