/**
 * SC-007 (S41): the politeness bound at scale, against a fixture fleet. Not a CI gate.
 *
 *   TS_NODE_TRANSPILE_ONLY=1 node -r ts-node/register -r tsconfig-paths/register \
 *     scripts/load-tests/competitor-crawl.ts [hosts=200] [targetsPerHost=20] [loops=64] [workMs=40]
 *
 * It drives the real Redis frontier (the same Lua scripts the worker uses) with `loops` concurrent fetch loops over
 * `hosts` x `targetsPerHost` queued targets. Every "fetch" is `workMs` of simulated work on a per-host counter, so the
 * report shows what the frontier allows, not what the network gives: fetches per second and, the number that must stay
 * at 1, the most requests ever in flight on one host, and the smallest gap between two requests of a host. The design
 * target is 460 fetches per second fleet-wide (10 M URLs every 6 hours): scale loops and worker instances until the
 * rate is reached; the per-host bound holds at any scale.
 */
import Redis from 'ioredis';
import { RedisFrontier } from '../../libs/domains/seller-insights/infra/redis-frontier';
import type { CrawlerConfig } from '../../libs/domains/seller-insights/application/crawler.config';

const [hostsArg, perHostArg, loopsArg, workArg] = process.argv.slice(2);
const HOSTS = Number(hostsArg ?? 200);
const PER_HOST = Number(perHostArg ?? 20);
const LOOPS = Number(loopsArg ?? 64);
const WORK_MS = Number(workArg ?? 40);
const GAP_MS = 1_000;

async function main() {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
  for (const key of await redis.keys('crawl:{s}:*')) await redis.del(key);
  const config = {
    settings: { leaseMs: 60_000, minGapMs: GAP_MS },
  } as CrawlerConfig;
  const frontier = new RedisFrontier(redis, () => Date.now(), config);

  for (let h = 0; h < HOSTS; h++)
    for (let t = 0; t < PER_HOST; t++)
      await frontier.push(`h${h}.load.test`, `${h}-${t}`);

  const inFlight = new Map<string, number>();
  const lastEnd = new Map<string, number>();
  let maxInFlight = 0;
  let minGap = Infinity;
  let done = 0;
  const total = HOSTS * PER_HOST;
  const started = Date.now();

  const loop = async () => {
    while (done < total) {
      const next = await frontier.take();
      if (!next) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      const open = (inFlight.get(next.host) ?? 0) + 1;
      inFlight.set(next.host, open);
      maxInFlight = Math.max(maxInFlight, open);
      const previous = lastEnd.get(next.host);
      if (previous !== undefined)
        minGap = Math.min(minGap, Date.now() - previous);
      await new Promise((r) => setTimeout(r, WORK_MS));
      inFlight.set(next.host, open - 1);
      lastEnd.set(next.host, Date.now());
      await frontier.release(next.host, GAP_MS);
      done++;
    }
  };
  await Promise.all(Array.from({ length: LOOPS }, loop));

  const seconds = (Date.now() - started) / 1000;
  console.log(
    JSON.stringify(
      {
        hosts: HOSTS,
        targets: total,
        loops: LOOPS,
        seconds: Number(seconds.toFixed(1)),
        fetchesPerSecond: Number((total / seconds).toFixed(1)),
        maxInFlightOnOneHost: maxInFlight,
        minGapBetweenRequestsMs: minGap === Infinity ? null : minGap,
        politenessHeld:
          maxInFlight === 1 && (minGap === Infinity || minGap >= GAP_MS - 50),
      },
      null,
      2,
    ),
  );
  await redis.quit();
  if (maxInFlight !== 1) process.exitCode = 1;
}

void main();
