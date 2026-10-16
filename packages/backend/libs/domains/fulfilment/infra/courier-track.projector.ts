import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type { Projector } from '@app/infrastructure/projections/projector';
import { CourierLocationsReported } from '../application/events/courier-events';
import { errorText, logDelivery } from '../application/delivery-log';
import { TRACK_STORE, type TrackStore } from '../domain/delivery-ports';
import { DeliveryMetrics } from '../application/delivery-metrics';

/**
 * `courier.locations_reported` -> DynamoDB `CourierTrack` (S20 FR-011, AS-10..AS-12), on its own consumer group. The
 * framework validates the envelope, the contract version and the payload (poison and unknown versions are
 * dead-lettered with a reason before this runs); a put is keyed by courier, day and timestamp, so a redelivery is the
 * same item. A store that stays unwell after the backoff makes the batch throw: nothing is acknowledged, and the
 * framework retries and then dead-letters the message whole.
 */
@Injectable()
export class CourierTrackProjector implements Projector {
  readonly name: string = 'courier-track';
  readonly topics: string[] = [CourierLocationsReported.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: CourierLocationsReported }];
  private readonly logger = new Logger(CourierTrackProjector.name);

  constructor(@Inject(TRACK_STORE) private readonly track: TrackStore) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const envelope of events) {
      const event = CourierLocationsReported.match(envelope);
      if (!event) continue;
      const { courierId, deliveryId, points } = event.payload;
      try {
        await this.track.putPoints(courierId, deliveryId, points);
      } catch (error) {
        DeliveryMetrics.historyFailures.add(1, { stage: 'store' });
        logDelivery(this.logger, 'error', 'courier.history_not_stored', {
          courierId,
          city: event.payload.city,
          ...(deliveryId && { deliveryId }),
          error: errorText(error),
        });
        throw error;
      }
    }
  }
}
