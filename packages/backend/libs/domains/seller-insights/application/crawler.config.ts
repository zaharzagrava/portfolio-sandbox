import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApiConfigService } from '@app/common/config';
import { Environment } from '@app/common/types';

/** The crawler's numbers (S41 AS-56, research D-13): validated once at start, then read from here and nowhere else. */
export interface CrawlerSettings {
  /** Fetch loops per worker instance. */
  fetchLoops: number;
  /** Minimum gap between two requests to one host. */
  minGapMs: number;
  /** Largest body read per request. */
  maxBodyBytes: number;
  /** Targets the scheduler queues per run. */
  scheduleCap: number;
  /** Host lease: a host a dead worker held is free again after this. */
  leaseMs: number;
  /** Local stand-in hosts the crawler may reach (never in production). */
  fixtureHosts: string[];
}

export const CRAWLER_DEFAULTS = {
  fetchLoops: 16,
  minGapMs: 1_000,
  maxBodyBytes: 2 * 1024 * 1024,
  scheduleCap: 5_000,
  leaseMs: 60_000,
} as const;

export class CrawlerConfigError extends Error {
  constructor(readonly keys: string[]) {
    super(`Invalid crawler configuration: ${keys.join(', ')}`);
    this.name = 'CrawlerConfigError';
  }
}

const bounded = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).optional();

const shape = z.object({
  crawler_fetch_loops: bounded(1, 64),
  crawler_min_gap_ms: bounded(1_000, 3_600_000),
  crawler_max_body_bytes: bounded(1_024, 8 * 1024 * 1024),
  crawler_schedule_cap: bounded(1, 100_000),
  crawler_lease_ms: bounded(10_000, 300_000),
  crawler_fixture_hosts: z.string().optional(),
});

const blank = (v: unknown) => (v === '' || v === null ? undefined : v);

/** Pure: the settings from raw configuration values; every violation names its key (never the value). */
export function parseCrawlerConfig(
  values: Record<string, unknown>,
  options: { production: boolean },
): CrawlerSettings {
  const parsed = shape.safeParse(
    Object.fromEntries(
      Object.keys(shape.shape).map((key) => [key, blank(values[key])]),
    ),
  );
  const keys: string[] = parsed.success
    ? []
    : [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
  const rawHosts = blank(values.crawler_fixture_hosts);
  const hosts = (typeof rawHosts === 'string' ? rawHosts : '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (options.production && hosts.length > 0)
    keys.push('crawler_fixture_hosts');
  if (!parsed.success || keys.length > 0) throw new CrawlerConfigError(keys);
  const v = parsed.data;
  return {
    fetchLoops: v.crawler_fetch_loops ?? CRAWLER_DEFAULTS.fetchLoops,
    minGapMs: v.crawler_min_gap_ms ?? CRAWLER_DEFAULTS.minGapMs,
    maxBodyBytes: v.crawler_max_body_bytes ?? CRAWLER_DEFAULTS.maxBodyBytes,
    scheduleCap: v.crawler_schedule_cap ?? CRAWLER_DEFAULTS.scheduleCap,
    leaseMs: v.crawler_lease_ms ?? CRAWLER_DEFAULTS.leaseMs,
    fixtureHosts: hosts,
  };
}

/** The settings of this process, read from the application configuration at construction (start-up fails on a bad one). */
@Injectable()
export class CrawlerConfig {
  readonly settings: CrawlerSettings;

  constructor(config: ApiConfigService) {
    const keys = [
      'crawler_fetch_loops',
      'crawler_min_gap_ms',
      'crawler_max_body_bytes',
      'crawler_schedule_cap',
      'crawler_lease_ms',
      'crawler_fixture_hosts',
    ] as const;
    this.settings = parseCrawlerConfig(
      Object.fromEntries(keys.map((k) => [k, config.get(k)])),
      { production: config.get('node_env') === Environment.production },
    );
  }
}
