import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { gzipSync } from 'node:zlib';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { Suggestion } from '../domain/top-k-trie';

import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'search.build-autocomplete': Record<string, never>;
  }
}

declareJobType({
  name: 'search.build-autocomplete',
  contract: z.object({}),
});

export const AUTOCOMPLETE_POINTER = 'autocomplete:current';
const MAX_QUERIES = 200_000;
const MIN_SEARCHERS = 5;
/** Never suggested, whatever their popularity (offensive, unsafe, competitor bait). */
const BLOCKLIST = [
  /\bfake\b/,
  /\bcounterfeit\b/,
  /\bstolen\b/,
  /\bhack(ed)?\b/,
];

/**
 * Offline half (lesson 10/05 #12): aggregate 30 days of searches in ClickHouse,
 * keep queries typed by ≥ 5 distinct people that returned results (typos and
 * one-off junk drop out), filter the blocklist, publish a versioned snapshot to
 * object storage and flip a pointer. Serving nodes hot-swap on the pointer.
 */
@Injectable()
export class AutocompleteBuilderJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(AutocompleteBuilderJobs.name);

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly storage: ObjectStorage,
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({
      name: 'search.build-autocomplete',
      cron: '7 * * * *',
      jobType: 'search.build-autocomplete',
      payload: {},
    });
  }

  @JobHandler('search.build-autocomplete', { concurrency: 1, leaseMs: 600_000 })
  async build(): Promise<number> {
    const rows = await this.clickhouse.query<{
      query: string;
      searchers: string;
    }>(
      `SELECT query, uniqCombined(user_hash) AS searchers
       FROM search_queries FINAL
       WHERE ts >= now() - INTERVAL 30 DAY AND results > 0
       GROUP BY query HAVING searchers >= {min:UInt32}
       ORDER BY searchers DESC LIMIT {limit:UInt32}`,
      { min: MIN_SEARCHERS, limit: MAX_QUERIES },
    );
    const suggestions: Suggestion[] = rows
      .filter((r) => !BLOCKLIST.some((re) => re.test(r.query)))
      .map((r) => ({ query: r.query, count: Number(r.searchers) }));

    const version = new Date().toISOString().replace(/[:.]/g, '-');
    await this.storage.put(
      `autocomplete/${version}.json.gz`,
      gzipSync(JSON.stringify(suggestions)),
      'application/gzip',
    );
    await this.redis.client.set(AUTOCOMPLETE_POINTER, version);
    this.logger.log(
      `autocomplete snapshot ${version}: ${suggestions.length} queries`,
    );
    return suggestions.length;
  }
}
