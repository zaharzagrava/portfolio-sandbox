import { Inject, Injectable, Logger } from '@nestjs/common';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import {
  DELIVERY_REPOSITORY,
  POSITION_THROTTLE,
  type DeliveryRecord,
  type DeliveryRepository,
  type OfferRecord,
  type PositionThrottle,
} from '../domain/delivery-ports';
import { POSITION_PUSH_WINDOW_MS } from '../domain/dispatch-rules';
import { DeliveryMetrics } from './delivery-metrics';
import { errorText, logDelivery, type DeliveryLogFields } from './delivery-log';

/**
 * The pushes of the delivery lifecycle (S20 FR-040, FR-041, A23), always after the commit and always best effort: a
 * failed push is counted and logged and never fails or undoes a transition. `status` goes to the buyer's topic (replayed
 * to a reconnecting client) without the courier's identity or any free text; `courier_position` is live only and
 * throttled; the courier hears about offers, withdrawals and cancellations on `user:<courierId>`.
 */
@Injectable()
export class DeliveryPushService {
  private readonly logger = new Logger(DeliveryPushService.name);

  constructor(
    private readonly realtime: RealtimePublisher,
    @Inject(POSITION_THROTTLE) private readonly throttle: PositionThrottle,
    @Inject(DELIVERY_REPOSITORY)
    private readonly deliveries: DeliveryRepository,
  ) {}

  /** The delivery moved: `status {status, deliveryVersion, at}`. */
  status(delivery: DeliveryRecord): Promise<void> {
    return this.send(
      'delivery',
      `delivery:${delivery.id}`,
      'status',
      {
        status: delivery.status,
        deliveryVersion: delivery.version,
        at: delivery.updatedAt.toISOString(),
      },
      { deliveryId: delivery.id, city: delivery.city },
    );
  }

  /**
   * The courier on the way reported a position: `courier_position {lat, lng, ts}`, at most one per delivery per window
   * and never stored for replay. The stored status decides (the live mirror can lag): only `ASSIGNED` and `PICKED_UP`
   * deliveries of this courier are followed. The throttle is claimed first, so the status read runs at most once per
   * window and delivery.
   */
  async courierPosition(
    courierId: string,
    city: string,
    deliveryId: string,
    point: { lat: number; lng: number; ts: number },
    now: number,
  ): Promise<void> {
    try {
      if (
        !(await this.throttle.claim(
          city,
          deliveryId,
          now,
          POSITION_PUSH_WINDOW_MS,
        ))
      )
        return;
      const delivery = await this.deliveries.findById(deliveryId);
      if (
        !delivery ||
        delivery.courierId !== courierId ||
        (delivery.status !== 'ASSIGNED' && delivery.status !== 'PICKED_UP')
      )
        return;
    } catch (error) {
      logDelivery(this.logger, 'warn', 'delivery.push_failed', {
        deliveryId,
        courierId,
        city,
        step: 'courier_position',
        error: errorText(error),
      });
      return;
    }
    await this.send(
      'delivery',
      `delivery:${deliveryId}`,
      'courier_position',
      { lat: point.lat, lng: point.lng, ts: point.ts },
      { deliveryId, courierId, city },
      { replay: false },
    );
  }

  /** `delivery_offer`: absolute expiry, the courier-side facts of the delivery. */
  offer(delivery: DeliveryRecord, offer: OfferRecord): Promise<void> {
    return this.send(
      'user',
      `user:${offer.courierId}`,
      'delivery_offer',
      {
        deliveryId: delivery.id,
        pickup: delivery.pickup,
        dropoff: delivery.dropoff,
        feeMinor: delivery.feeMinor,
        currency: delivery.currency,
        expiresAt: offer.expiresAt.toISOString(),
      },
      {
        deliveryId: delivery.id,
        courierId: offer.courierId,
        city: delivery.city,
      },
    );
  }

  offerWithdrawn(courierId: string, deliveryId: string): Promise<void> {
    return this.send(
      'user',
      `user:${courierId}`,
      'delivery_offer_withdrawn',
      { deliveryId },
      { deliveryId, courierId },
    );
  }

  /** The delivery the courier was assigned to is cancelled. */
  courierCancelled(courierId: string, deliveryId: string): Promise<void> {
    return this.send(
      'user',
      `user:${courierId}`,
      'delivery_cancelled',
      { deliveryId },
      { deliveryId, courierId },
    );
  }

  private async send(
    kind: 'delivery' | 'user',
    topic: `delivery:${string}` | `user:${string}`,
    type: string,
    data: unknown,
    ids: Pick<DeliveryLogFields, 'deliveryId' | 'courierId' | 'city'>,
    options?: { replay: boolean },
  ): Promise<void> {
    try {
      const result = await this.realtime.publish(topic, type, data, options);
      if (!result.published) {
        DeliveryMetrics.pushFailures.add(1, { topic: kind });
        logDelivery(this.logger, 'warn', 'delivery.push_failed', {
          ...ids,
          step: type,
          error: 'the realtime store did not take the message',
        });
      }
    } catch (error) {
      DeliveryMetrics.pushFailures.add(1, { topic: kind });
      logDelivery(this.logger, 'warn', 'delivery.push_failed', {
        ...ids,
        step: type,
        error: errorText(error),
      });
    }
  }
}
