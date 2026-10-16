import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  LocationBatchRequest,
  LocationBatchResponse,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import {
  COURIER_REPOSITORY,
  GEO_INDEX,
  type CourierRepository,
  type GeoIndex,
} from '../domain/delivery-ports';
import {
  CourierProfileRequiredError,
  DeliveryUnavailableError,
  LocationHistoryUnavailableError,
} from '../domain/delivery-errors';
import { partitionPoints } from '../domain/location-window';
import { DeliveryMetrics } from './delivery-metrics';
import { errorText, logDelivery } from './delivery-log';
import { DeliveryPushService } from './delivery-push.service';
import { CourierLocationsReported } from './events/courier-events';

const NO_DROPS = { stale: 0, future: 0 };

/**
 * Location ingest, the hot path (S20 FR-005..FR-010, A19..A21): one read of the courier's profile by primary key, the
 * time-window split, ONE call to the live index (position and searchable set together, newer-only) and one direct
 * produce of the history message keyed by city. No Postgres write. The identity and the city are the session's and the
 * registered profile's - never the body's.
 */
@Injectable()
export class LocationIngestService {
  private readonly logger = new Logger(LocationIngestService.name);

  constructor(
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(GEO_INDEX) private readonly geo: GeoIndex,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly producer: KafkaProducerService,
    private readonly push: DeliveryPushService,
  ) {}

  async ingest(
    courierId: string,
    batch: LocationBatchRequest,
  ): Promise<LocationBatchResponse> {
    const courier = await this.couriers.find(courierId);
    if (!courier) throw new CourierProfileRequiredError();

    if (courier.status === 'OFFLINE') {
      // An off-shift courier's whereabouts are not recorded.
      DeliveryMetrics.locationPoints.add(batch.points.length, {
        result: 'off_shift',
      });
      return {
        accepted: 0,
        dropped: { ...NO_DROPS },
        applied: false,
        reason: 'off_shift',
      };
    }

    const { accepted, dropped } = partitionPoints(
      batch.points,
      this.clock.nowMs(),
    );
    if (dropped.stale > 0)
      DeliveryMetrics.locationPoints.add(dropped.stale, { result: 'stale' });
    if (dropped.future > 0)
      DeliveryMetrics.locationPoints.add(dropped.future, { result: 'future' });
    if (accepted.length === 0) return { accepted: 0, dropped, applied: false };

    const points = [...accepted].sort((a, b) => a.ts - b.ts);
    const latest = points[points.length - 1];

    let live: { applied: boolean; deliveryId: string | null };
    try {
      live = await this.geo.applyLocation({
        city: courier.city,
        courierId,
        lat: latest.lat,
        lng: latest.lng,
        ts: latest.ts,
        searchable: courier.status === 'AVAILABLE',
      });
    } catch (error) {
      logDelivery(this.logger, 'error', 'courier.live_index_failed', {
        courierId,
        city: courier.city,
        error: errorText(error),
      });
      throw new DeliveryUnavailableError();
    }
    DeliveryMetrics.locationPoints.add(points.length, {
      result: live.applied ? 'applied' : 'late',
    });

    try {
      await this.producer.send({
        topic: CourierLocationsReported.topic,
        key: courier.city,
        value: CourierLocationsReported.create(courierId, 0, {
          courierId,
          city: courier.city,
          deliveryId: live.deliveryId,
          points,
        }),
      });
    } catch (error) {
      DeliveryMetrics.historyFailures.add(1, { stage: 'produce' });
      logDelivery(this.logger, 'error', 'courier.history_not_produced', {
        courierId,
        city: courier.city,
        error: errorText(error),
      });
      throw new LocationHistoryUnavailableError();
    }
    // Live tracking: the newest point of a courier on the way, throttled and best effort (FR-040).
    if (live.applied && live.deliveryId)
      await this.push.courierPosition(
        courierId,
        courier.city,
        live.deliveryId,
        { lat: latest.lat, lng: latest.lng, ts: latest.ts },
        this.clock.nowMs(),
      );
    return { accepted: points.length, dropped, applied: live.applied };
  }
}
