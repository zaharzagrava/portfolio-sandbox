import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ResilientHttpClient } from '@app/infrastructure/http-client';
import { STORY_DEFAULTS, type StoryConfig } from '../domain/limits';
import { STORY_CONFIG } from '../application/story-config.token';
import { signRevalidation } from '../domain/revalidation-signature';
import type { RevalidationClient } from '../domain/ports';
import { storyMetrics } from '../application/story-metrics';

/**
 * Tells the front end to drop its route cache for the tags (S27 FR-031): `POST <front>/api/revalidate` with the body
 * `{tags, eventId}`, `X-Revalidate-Timestamp` (unix seconds, platform clock) and `X-Revalidate-Signature`
 * (hex HMAC-SHA256 of `"<timestamp>.<raw body>"`). One attempt with a 5 s timeout: a failure fails the event, which is
 * redelivered; the receiver treats the call as idempotent.
 */
export class HttpRevalidationClient implements RevalidationClient {
  private readonly http = ResilientHttpClient.create({
    name: 'story-revalidate',
    internal: true,
    breaker: false,
  });

  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly clock: Clock,
    private readonly timeoutMs: () => number = () =>
      STORY_DEFAULTS.cdnTimeoutMs,
  ) {}

  async revalidate(tags: string[], eventId: string): Promise<void> {
    const body = JSON.stringify({ tags, eventId });
    const timestamp = Math.floor(this.clock.nowMs() / 1_000);
    try {
      await this.http.requestJson(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-revalidate-timestamp': String(timestamp),
          'x-revalidate-signature': signRevalidation(
            this.secret,
            timestamp,
            body,
          ),
        },
        body,
        idempotent: true,
        maxAttempts: 1,
        timeoutMs: this.timeoutMs(),
      });
      storyMetrics.cachePurge.add(1, { target: 'revalidate', result: 'ok' });
    } catch (error) {
      storyMetrics.cachePurge.add(1, {
        target: 'revalidate',
        result: 'failed',
      });
      throw error;
    }
  }
}

/** Outside production without a secret: the call is logged and nothing leaves the process (S27 AS-59). */
@Injectable()
export class LoggingRevalidationClient implements RevalidationClient {
  private readonly logger = new Logger('RevalidationClient');
  readonly calls: { tags: string[]; eventId: string }[] = [];

  revalidate(tags: string[], eventId: string): Promise<void> {
    this.calls.push({ tags, eventId });
    this.logger.log(`revalidate tags: ${tags.join(', ')}`);
    storyMetrics.cachePurge.add(1, { target: 'revalidate', result: 'ok' });
    return Promise.resolve();
  }
}

/** The adapter the module provides: HTTP when the secret and an address are configured, logging otherwise (per call). */
@Injectable()
export class ConfiguredRevalidationClient implements RevalidationClient {
  readonly logging = new LoggingRevalidationClient();
  private http: { key: string; client: HttpRevalidationClient } | undefined;

  constructor(
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORY_CONFIG) private readonly limits: StoryConfig,
  ) {}

  revalidate(tags: string[], eventId: string): Promise<void> {
    const secret = this.config.get('revalidate_secret');
    const front = this.config.get('front_host');
    const url =
      this.config.get('revalidate_url') ||
      (front ? `${front}/api/revalidate` : '');
    if (!secret || !url) return this.logging.revalidate(tags, eventId);
    const key = `${secret}|${url}`;
    if (this.http?.key !== key)
      this.http = {
        key,
        client: new HttpRevalidationClient(
          url,
          secret,
          this.clock,
          () => this.limits.cdnTimeoutMs,
        ),
      };
    return this.http.client.revalidate(tags, eventId);
  }
}
