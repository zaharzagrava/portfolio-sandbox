import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { InvalidEventPayloadError } from '@app/infrastructure/events/event-errors';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { SinkCounts } from '@app/infrastructure/projections/projector';
import {
  MediaGalleryChanged,
  ProductSponsorshipChanged,
} from '../../domain/consumed-events';
import {
  galleryMutation,
  sponsorshipMutation,
  type Mutation,
} from '../../domain/index-document';
import {
  PRODUCT_IMAGE_RESOLVER,
  PRODUCT_INDEX,
  type ProductImageResolver,
  type ProductIndexPort,
} from '../../domain/ports';
import {
  searchIgnoredCounter,
  searchStaleIgnoredCounter,
} from '../../infra/search-metrics';
import { SearchSettings } from '../../infra/search-settings';
import { guarded, recordLag, UUID } from './projection-support';

/**
 * `media.gallery_changed` (image) and `marketing.product_sponsorship_changed` (sponsored flag) into the index. Each
 * signal has its own version and writes only its own fields; a signal for a product the index has not seen yet is kept
 * on a document that stays invisible until the product event arrives (S32 FR-019, AS-31, AS-32).
 */
@Injectable()
export class SignalProjectionService {
  constructor(
    @Inject(PRODUCT_INDEX) private readonly index: ProductIndexPort,
    @Inject(PRODUCT_IMAGE_RESOLVER)
    private readonly images: ProductImageResolver,
    private readonly settings: SearchSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async projectGallery(events: EventEnvelope[]): Promise<SinkCounts> {
    const weights = this.settings.boostWeights;
    const parsed = this.latest(events, MediaGalleryChanged, 'galleryVersion');
    return guarded(async () => {
      const first = parsed
        .map((p) => p.payload.mediaIds[0])
        .filter((id): id is string => Boolean(id));
      const thumbs = await this.images.thumbnails(first);
      return this.apply(
        'gallery',
        parsed,
        (p): Mutation =>
          galleryMutation({
            productId: p.payload.productId,
            shopId: p.payload.shopId,
            imageUrl: p.payload.mediaIds[0]
              ? (thumbs.get(p.payload.mediaIds[0]) ?? null)
              : null,
            galleryVersion: p.payload.galleryVersion,
            weights,
          }),
      );
    });
  }

  async projectSponsorship(events: EventEnvelope[]): Promise<SinkCounts> {
    const weights = this.settings.boostWeights;
    const parsed = this.latest(
      events,
      ProductSponsorshipChanged,
      'sponsorshipVersion',
    );
    return guarded(() =>
      this.apply(
        'sponsorship',
        parsed,
        (p): Mutation =>
          sponsorshipMutation({
            productId: p.payload.productId,
            shopId: p.payload.shopId,
            sponsored: p.payload.sponsored,
            sponsorshipVersion: p.payload.sponsorshipVersion,
            weights,
          }),
      ),
    );
  }

  private async apply<P extends { productId: string }>(
    source: string,
    parsed: { envelope: EventEnvelope; payload: P }[],
    mutation: (p: { envelope: EventEnvelope; payload: P }) => Mutation,
  ): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    if (parsed.length === 0) return counts;
    const outcomes = await this.index.mutate(
      parsed.map((p) => ({ id: p.payload.productId, mutation: mutation(p) })),
    );
    for (const outcome of outcomes.values()) {
      if (outcome === 'stale') {
        counts.stale++;
        searchStaleIgnoredCounter.add(1, { source });
      } else if (outcome === 'duplicate') counts.duplicate++;
      else counts.applied++;
    }
    const now = this.clock.now();
    for (const p of parsed) recordLag(source, p.envelope.occurredAt, now);
    return counts;
  }

  /** Validates, drops other types, keeps the highest signal version per product. */
  private latest<
    P extends { productId: string; shopId: string } & Record<string, unknown>,
  >(
    events: EventEnvelope[],
    definition: {
      type: string;
      match(e: EventEnvelope): { payload: P } | null;
    },
    versionField: keyof P,
  ): { envelope: EventEnvelope; payload: P }[] {
    const out = new Map<string, { envelope: EventEnvelope; payload: P }>();
    for (const envelope of events) {
      if (envelope.type !== definition.type) {
        searchIgnoredCounter.add(1, { reason: 'unknown_type' });
        continue;
      }
      let payload: P;
      try {
        const event = definition.match(envelope);
        if (!event)
          throw new PermanentError(
            `unsupported contract version ${envelope.version} of ${envelope.type}`,
          );
        payload = event.payload;
      } catch (error) {
        if (error instanceof InvalidEventPayloadError)
          throw new PermanentError(error.message, { cause: error });
        throw error;
      }
      if (!UUID.test(payload.productId) || payload.productId !== envelope.aggregateId)
        throw new PermanentError(
          `productId of ${envelope.type} is not the aggregate id`,
        );
      const key = payload.productId;
      const current = out.get(key);
      if (
        !current ||
        (payload[versionField] as number) >= (current.payload[versionField] as number)
      )
        out.set(key, { envelope, payload });
    }
    return [...out.values()];
  }
}
