import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { SignalProjectionService } from '../../application/projection/signal-projection.service';
import {
  MediaGalleryChanged,
  ProductSponsorshipChanged,
} from '../../domain/consumed-events';

/** Group `search-media`: the primary image of a product (`media.gallery_changed`, guarded by `galleryVersion`). */
@Injectable()
export class MediaProjector implements Projector {
  readonly name = 'search-media';
  readonly topics = [MediaGalleryChanged.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [{ event: MediaGalleryChanged }];
  readonly coalesce = true;
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly signals: SignalProjectionService) {}

  project(events: EventEnvelope[]): Promise<SinkCounts> {
    return this.signals.projectGallery(events);
  }
}

/** Group `search-sponsorship`: the sponsored flag (`marketing.product_sponsorship_changed`, `sponsorshipVersion`). */
@Injectable()
export class SponsorshipProjector implements Projector {
  readonly name = 'search-sponsorship';
  readonly topics = [ProductSponsorshipChanged.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [{ event: ProductSponsorshipChanged }];
  readonly coalesce = true;
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly signals: SignalProjectionService) {}

  project(events: EventEnvelope[]): Promise<SinkCounts> {
    return this.signals.projectSponsorship(events);
  }
}
