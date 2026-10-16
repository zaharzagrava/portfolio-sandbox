import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';
import {
  HttpClientError,
  ResilientHttpClient,
} from '@app/infrastructure/http-client';
import { LIMITS, STORY_DEFAULTS, type StoryConfig } from '../domain/limits';
import { STORY_CONFIG } from '../application/story-config.token';
import {
  CdnPermanentError,
  CdnTransientError,
  type CdnPurger,
} from '../domain/ports';
import { storyMetrics } from '../application/story-metrics';

const DEFAULT_API = 'https://api.cloudflare.com/client/v4';
const BACKOFF = { baseMs: 100, maxMs: 2_000 } as const;

/** Statuses worth another try: the CDN is busy or unwell. Any other 4xx is a refusal that retrying cannot fix. */
const retryable = (status: number | undefined): boolean =>
  status === undefined || status === 429 || status >= 500;

/**
 * Purges the CDN by cache tag (S27 FR-031, FR-032): at most 30 tags per call, 5 s per attempt, at most 3 retries inside
 * the call with full jitter on a timeout, `429` or `5xx`; a `4xx` other than `429` (bad credentials) is permanent.
 * Each attempt is counted in `story_cache_purge_total{target="cdn"}`. Purging a tag twice is harmless.
 */
export class HttpCdnPurger implements CdnPurger {
  private readonly http = ResilientHttpClient.create({
    name: 'story-cdn',
    breaker: false,
  });

  constructor(
    private readonly zone: string,
    private readonly token: string,
    private readonly apiUrl: string = DEFAULT_API,
    private readonly timeoutMs: () => number = () =>
      STORY_DEFAULTS.cdnTimeoutMs,
    private readonly random: () => number = Math.random,
  ) {}

  async purgeTags(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    if (tags.length > LIMITS.tagsPerCall)
      throw new CdnPermanentError('too many tags in one call');
    const attempts = LIMITS.cdnRetries + 1;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.http.requestJson(
          `${this.apiUrl}/zones/${encodeURIComponent(this.zone)}/purge_cache`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ tags }),
            idempotent: true,
            maxAttempts: 1,
            timeoutMs: this.timeoutMs(),
          },
        );
        storyMetrics.cachePurge.add(1, { target: 'cdn', result: 'ok' });
        return;
      } catch (error) {
        const status =
          error instanceof HttpClientError ? error.status : undefined;
        if (!retryable(status)) {
          storyMetrics.cachePurge.add(1, {
            target: 'cdn',
            result: 'permanent',
          });
          throw new CdnPermanentError(`cdn refused the purge (${status})`);
        }
        if (attempt + 1 >= attempts) {
          storyMetrics.cachePurge.add(1, { target: 'cdn', result: 'failed' });
          throw new CdnTransientError('cdn purge did not succeed');
        }
        storyMetrics.cachePurge.add(1, { target: 'cdn', result: 'retry' });
        await sleep(fullJitterBackoff(attempt, BACKOFF, this.random));
      }
    }
  }
}

/** Outside production without credentials: the tags are logged and nothing leaves the process (S27 AS-59). */
@Injectable()
export class LoggingCdnPurger implements CdnPurger {
  private readonly logger = new Logger('CdnPurger');
  readonly purged: string[][] = [];

  purgeTags(tags: string[]): Promise<void> {
    this.purged.push(tags);
    this.logger.log(`purge tags: ${tags.join(', ')}`);
    storyMetrics.cachePurge.add(1, { target: 'cdn', result: 'ok' });
    return Promise.resolve();
  }
}

/**
 * The adapter the module provides: the HTTP purger when the CDN credentials are configured, the logging one when they
 * are not (S27 FR-034; production refuses to start without them, see `stories-config.ts`). The choice is made per call
 * from the live configuration, so a rotated credential needs no restart and a spec can switch it.
 */
@Injectable()
export class ConfiguredCdnPurger implements CdnPurger {
  readonly logging = new LoggingCdnPurger();
  private http: { key: string; purger: HttpCdnPurger } | undefined;

  constructor(
    private readonly config: ApiConfigService,
    @Inject(STORY_CONFIG) private readonly limits: StoryConfig,
  ) {}

  purgeTags(tags: string[]): Promise<void> {
    const zone = this.config.get('cdn_zone');
    const token = this.config.get('cdn_token');
    if (!zone || !token) return this.logging.purgeTags(tags);
    const api = this.config.get('cdn_api_url') || DEFAULT_API;
    const key = `${zone}|${token}|${api}`;
    if (this.http?.key !== key)
      this.http = {
        key,
        purger: new HttpCdnPurger(
          zone,
          token,
          api,
          () => this.limits.cdnTimeoutMs,
        ),
      };
    return this.http.purger.purgeTags(tags);
  }
}
