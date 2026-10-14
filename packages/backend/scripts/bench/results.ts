/**
 * Benchmark of the results read (S39 SC-006): one experiment with 1,000,000 exposed units and 100,000 conversions in the
 * analytical store, read 100 times through the real `ClickHouseEventStore` query. An ops artifact (specs/UNVERIFIED.md): it
 * prints the numbers and whether the 3 s p95 budget holds, it does not gate the build.
 *
 * It WRITES 1.1 million rows into `analytics_event_log` of the configured ClickHouse database (CLICKHOUSE_URL,
 * CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DATABASE, as for the application; use a throwaway database) and removes
 * them again at the end (CLEANUP=false keeps them).
 *
 * Run: pnpm bench:results            (UNITS=1000000 READS=100 to change the sizes)
 */
import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { createClient } from '@clickhouse/client';
import type { ClickHouseService } from '../../libs/infrastructure/clickhouse/clickhouse.service';
import { ClickHouseEventStore } from '../../libs/domains/experimentation/infra/clickhouse-event-store';

const UNITS = Number(process.env.UNITS ?? 1_000_000);
const CONVERSIONS = Math.floor(UNITS / 10);
const READS = Number(process.env.READS ?? 100);
const BUDGET_MS = 3_000;
const KEY = `bench-results-${Date.now()}`;

async function main() {
  const client = createClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: process.env.CLICKHOUSE_DATABASE ?? 'marketplace',
    request_timeout: 600_000,
  });
  const store = new ClickHouseEventStore({
    getClient: () => client,
  } as unknown as ClickHouseService);

  const seed = (name: string, rows: number, props: string) =>
    client.command({
      query: `INSERT INTO analytics_event_log (event_id, name, anonymous_id, user_id, ts, received_at, country, platform, page, props)
        SELECT generateUUIDv4(), '${name}', concat('bench-anon-', toString(number)), concat('bench-user-', toString(number)),
               now64(3) - toIntervalSecond(${name === 'exposure' ? 1800 : 900}), now64(3), '', 'web', '', ${props}
        FROM numbers(${rows})`,
    });
  console.error(`seeding ${UNITS} exposures and ${CONVERSIONS} conversions for ${KEY} ...`);
  await seed(
    'exposure',
    UNITS,
    `map('experiment', '${KEY}', 'variant', if(number % 2 = 0, 'control', 'treatment'))`,
  );
  await seed('purchase', CONVERSIONS, 'map()');

  const query = {
    experimentKey: KEY,
    metric: 'purchase',
    unit: 'user' as const,
    variants: ['control', 'treatment'],
    windowStart: new Date(Date.now() - 3_600_000),
    windowEnd: new Date(),
  };
  const timings: number[] = [];
  let counted = 0;
  for (let i = 0; i < READS; i++) {
    const started = performance.now();
    const counts = await store.readResults(query);
    timings.push(performance.now() - started);
    counted = counts.variants.reduce((n, v) => n + v.exposures, 0);
  }
  timings.sort((a, b) => a - b);
  const at = (p: number) => timings[Math.min(timings.length - 1, Math.floor(p * timings.length))];
  console.log(
    JSON.stringify(
      {
        exposedUnits: counted,
        reads: READS,
        p50Ms: Math.round(at(0.5)),
        p95Ms: Math.round(at(0.95)),
        maxMs: Math.round(timings[timings.length - 1]),
        budgetMs: BUDGET_MS,
        withinBudget: at(0.95) < BUDGET_MS,
      },
      null,
      2,
    ),
  );

  if (process.env.CLEANUP !== 'false') {
    await client.command({
      query: `ALTER TABLE analytics_event_log DELETE WHERE props['experiment'] = '${KEY}' OR (name = 'purchase' AND startsWith(user_id, 'bench-user-'))`,
      clickhouse_settings: { mutations_sync: '1' },
    });
  }
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
