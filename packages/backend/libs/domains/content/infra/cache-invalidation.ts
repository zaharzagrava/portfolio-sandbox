import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { ResilientHttpClient } from '@app/infrastructure/http-client';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { StoryPublished } from '../application/events/story-events';

/** Port: purge CDN objects by cache tag. Real adapter = Cloudflare API; without credentials it only logs. */
export abstract class CdnPurger {
  abstract purgeTags(tags: string[]): Promise<void>;
}

export class CloudflarePurger extends CdnPurger {
  private readonly http = ResilientHttpClient.create({ name: 'cloudflare' });

  constructor(
    private readonly zoneId: string,
    private readonly token: string,
  ) {
    super();
  }

  async purgeTags(tags: string[]) {
    // Cloudflare accepts ≤ 30 tags per call.
    for (let i = 0; i < tags.length; i += 30) {
      const res = await this.http.requestJson<{
        success: boolean;
        errors?: unknown[];
      }>(
        `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/purge_cache`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ tags: tags.slice(i, i + 30) }),
          idempotent: true, // purging twice is harmless
          timeoutMs: 5_000,
        },
      );
      if (!res.body.success)
        throw new Error(
          `cloudflare purge failed: ${JSON.stringify(res.body.errors)}`,
        );
    }
  }
}

export class LoggingPurger extends CdnPurger {
  private readonly logger = new Logger('CdnPurger');
  readonly purged: string[][] = [];

  async purgeTags(tags: string[]) {
    this.purged.push(tags);
    this.logger.log(`purge tags: ${tags.join(', ')}`);
  }
}

/**
 * stories.events → invalidate every cache layer by TAG (10/04 #5): the CDN
 * (`Cache-Tag: story:<id>, shop:<id>` set on responses) and Next.js ISR
 * (`revalidateTag`, via a signed webhook). Tags, not URLs: one story is
 * served under many URLs (locales, AMP, embeds) - one purge hits them all.
 */
@Injectable()
export class StoryCacheInvalidator implements Projector {
  readonly name = 'story-cache-invalidation';
  readonly topics = [StoryPublished.topic];
  private readonly http = ResilientHttpClient.create({
    name: 'next-revalidate',
    internal: true,
  });

  constructor(
    private readonly purger: CdnPurger,
    private readonly config: ApiConfigService,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const tags = [
      ...new Set(
        events
          .map((e) => StoryPublished.match(e))
          .filter((e): e is NonNullable<typeof e> => !!e)
          .flatMap(({ payload }) => [
            `story:${payload.storyId}`,
            `shop:${payload.shopId}`,
          ]),
      ),
    ];
    if (tags.length === 0) return;
    await this.purger.purgeTags(tags);
    const secret = this.config.get('revalidate_secret');
    if (!secret) return;
    const body = JSON.stringify({ tags, at: Date.now() });
    await this.http.requestJson(
      `${this.config.get('front_host')}/api/revalidate`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-revalidate-signature': createHmac('sha256', secret)
            .update(body)
            .digest('hex'),
        },
        body,
        idempotent: true,
        timeoutMs: 5_000,
      },
    );
  }
}

export const CDN_PURGER_PROVIDER = {
  provide: CdnPurger,
  inject: [ApiConfigService],
  useFactory: (config: ApiConfigService) => {
    const zone = config.get('cloudflare_zone_id');
    const token = config.get('cloudflare_api_token');
    return zone && token
      ? new CloudflarePurger(zone, token)
      : new LoggingPurger();
  },
};
