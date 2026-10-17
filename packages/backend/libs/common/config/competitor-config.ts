import * as joi from 'joi';
import { ConfigRules, type RuleCheck } from './config-rules';

/**
 * Settings of the competitor price crawler (S41 AS-56, research D-13). Unset keys take the defaults of
 * `CrawlerConfig`; a value outside its bounds fails start-up naming the key.
 */
export interface CompetitorConfig {
  /** Fetch loops per worker instance (1 to 64, default 16). */
  crawler_fetch_loops?: number;
  /** Minimum gap between two requests to one host in ms (at least 1000, default 1000). */
  crawler_min_gap_ms?: number;
  /** Largest page body read per request in bytes (at most 8 MiB, default 2 MiB). */
  crawler_max_body_bytes?: number;
  /** Targets the scheduler queues per run (1 to 100,000, default 5000). */
  crawler_schedule_cap?: number;
  /** Host lease in ms (10,000 to 300,000, default 60,000). */
  crawler_lease_ms?: number;
  /** Comma separated hosts of fixture sites; refused when the environment is production. */
  crawler_fixture_hosts?: string;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: string) => number | undefined;
};

const number = (
  min: number,
  max: number,
): Pick<Key, 'verify' | 'postProcess'> => ({
  verify: joi.number().integer().min(min).max(max).optional(),
  postProcess: (v: string) => (v ? Number(v) : undefined),
});

export const competitorConfigKeys: Record<keyof CompetitorConfig, Key> = {
  crawler_fetch_loops: { name: 'CRAWLER_FETCH_LOOPS', ...number(1, 64) },
  crawler_min_gap_ms: {
    name: 'CRAWLER_MIN_GAP_MS',
    ...number(1_000, 3_600_000),
  },
  crawler_max_body_bytes: {
    name: 'CRAWLER_MAX_BODY_BYTES',
    ...number(1_024, 8 * 1024 * 1024),
  },
  crawler_schedule_cap: {
    name: 'CRAWLER_SCHEDULE_CAP',
    ...number(1, 100_000),
  },
  crawler_lease_ms: { name: 'CRAWLER_LEASE_MS', ...number(10_000, 300_000) },
  crawler_fixture_hosts: {
    name: 'CRAWLER_FIXTURE_HOSTS',
    verify: joi.string().optional().allow(''),
  },
};

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/** The fixture allowlist lets the crawler reach local stand-in hosts: never in production. */
export const competitorProductionRule: RuleCheck = (ctx) =>
  ctx.production && isSet(ctx.get('crawler_fixture_hosts'))
    ? ['crawler_fixture_hosts is not allowed in production']
    : [];

ConfigRules.register({
  owner: 'competitor-monitor',
  keys: ['crawler_fixture_hosts'],
  validate: competitorProductionRule,
});
