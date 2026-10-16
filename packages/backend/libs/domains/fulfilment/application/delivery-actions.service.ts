import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DeliveryShopView } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  COURIER_REPOSITORY,
  DELIVERY_REPOSITORY,
  GEO_INDEX,
  OFFER_GUARD,
  OFFER_REPOSITORY,
  type CourierRepository,
  type DeliveryRecord,
  type DeliveryRepository,
  type GeoIndex,
  type OfferGuard,
  type OfferRepository,
  type TransitionedDelivery,
} from '../domain/delivery-ports';
import {
  IN_TRANSIT_NOTE,
  SHOP_DELETED_IN_TRANSIT_NOTE,
  SYSTEM_CANCEL_REASONS,
} from '../domain/dispatch-rules';
import {
  DeliveryNotFoundError,
  InvalidDeliveryTransitionError,
} from '../domain/delivery-errors';
import type { ActorKind } from '../domain/delivery-state';
import { toShopView } from '../domain/delivery-views';
import { DeliveryMetrics } from './delivery-metrics';
import { afterCommit } from './after-commit';
import { logDelivery } from './delivery-log';
import { DeliveryPushService } from './delivery-push.service';
import { OrderWriteBackScheduler } from './order-lifecycle.service';

type CourierStep = 'pickUp' | 'deliver';

/** Page size of the shop-deleted sweep. */
const SHOP_SWEEP_PAGE = 100;

interface Canceller {
  kind: ActorKind;
  actorId: string | null;
  reason: string;
}

/**
 * The moves of an assigned delivery and every cancellation (S20 FR-023..FR-027): picked-up, delivered, cancel by the
 * shop, and the cancellations caused by `order.cancelled` and `tenancy.shop_deleted`. Each is ONE conditional
 * transition with its effects (a courier freed, an offer closed) in the same transaction; pushes, cache mirrors and
 * the order write-back follow the commit. The caller is in the predicate: a courier's step is a conditional update
 * on `courierId = caller`, a shop's cancel finds the delivery by `(shopId, id)`. A repeat by the same actor is a
 * success without a new row or event (FR-025).
 */
@Injectable()
export class DeliveryActionsService {
  private readonly logger = new Logger(DeliveryActionsService.name);

  constructor(
    @Inject(DELIVERY_REPOSITORY)
    private readonly deliveries: DeliveryRepository,
    @Inject(OFFER_REPOSITORY) private readonly offers: OfferRepository,
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(GEO_INDEX) private readonly geo: GeoIndex,
    @Inject(OFFER_GUARD) private readonly guard: OfferGuard,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: TransactionRunner,
    private readonly push: DeliveryPushService,
    private readonly writeBack: OrderWriteBackScheduler,
  ) {}

  pickUp(
    deliveryId: string,
    courierId: string,
    now: Date = this.clock.now(),
  ): Promise<void> {
    return this.courierStep(deliveryId, courierId, 'pickUp', now);
  }

  deliver(
    deliveryId: string,
    courierId: string,
    now: Date = this.clock.now(),
  ): Promise<void> {
    return this.courierStep(deliveryId, courierId, 'deliver', now);
  }

  private async courierStep(
    deliveryId: string,
    courierId: string,
    step: CourierStep,
    now: Date,
  ): Promise<void> {
    const target = step === 'pickUp' ? 'PICKED_UP' : 'DELIVERED';
    const moved = await this.runner.run(async () => {
      const done = await this.deliveries.transition({
        deliveryId,
        command: { type: step, actor: 'courier', courierId },
        actorId: courierId,
        now,
      });
      if (done) {
        if (step === 'deliver') await this.couriers.markAvailable(courierId);
        return done;
      }
      // Not moved: tell a replay (a success) from a move beyond the target (409) and from a stranger (404).
      const current = await this.deliveries.findById(deliveryId);
      const related =
        current !== null &&
        (current.courierId === courierId ||
          (await this.offers.findForCourier(deliveryId, courierId)) !== null);
      if (!current || !related) throw new DeliveryNotFoundError();
      if (current.courierId === courierId && current.status === target)
        return null;
      throw new InvalidDeliveryTransitionError(current.status, step);
    });
    if (!moved) return;

    logDelivery(
      this.logger,
      'log',
      'delivery.' + (step === 'deliver' ? 'delivered' : 'picked_up'),
      {
        deliveryId,
        courierId,
        city: moved.city,
        status: moved.status,
      },
    );
    await afterCommit(
      this.logger,
      step,
      [
        () => this.push.status(moved),
        () => this.writeBack.schedule(moved),
        ...(step === 'deliver'
          ? [() => this.geo.setStatus(moved.city, courierId, 'AVAILABLE', null)]
          : []),
      ],
      { deliveryId, courierId, city: moved.city },
    );
  }

  /** `POST /shops/:shopId/deliveries/:id/cancel`: the shop is in the predicate, a stranger's id is a 404. */
  async cancelByShop(
    shopId: string,
    deliveryId: string,
    actorId: string,
    reason: string,
    now: Date = this.clock.now(),
  ): Promise<DeliveryShopView> {
    const found = await this.deliveries.findForShop(shopId, deliveryId);
    if (!found) throw new DeliveryNotFoundError();
    const cancelled = await this.cancelOne(
      deliveryId,
      { kind: 'shop', actorId, reason },
      now,
    );
    if (!cancelled) {
      const current = await this.deliveries.findById(deliveryId);
      throw new InvalidDeliveryTransitionError(
        current?.status ?? found.status,
        'cancel',
      );
    }
    return toShopView(cancelled);
  }

  /** `order.cancelled`: every open delivery of the order; one in transit is flagged, not cancelled (FR-027). */
  async cancelByOrder(
    orderId: string,
    now: Date = this.clock.now(),
  ): Promise<{ cancelled: number; flagged: number }> {
    const counts = { cancelled: 0, flagged: 0 };
    for (const delivery of await this.deliveries.listOpenByOrder(orderId))
      await this.cancelOrFlag(
        delivery,
        {
          kind: 'order',
          actorId: null,
          reason: SYSTEM_CANCEL_REASONS.orderCancelled,
        },
        IN_TRANSIT_NOTE,
        counts,
        now,
      );
    return counts;
  }

  /** `tenancy.shop_deleted`: every open delivery of the shop, paged by id. */
  async cancelByShopDeleted(
    shopId: string,
    now: Date = this.clock.now(),
  ): Promise<{ cancelled: number; flagged: number }> {
    const counts = { cancelled: 0, flagged: 0 };
    let after: string | undefined;
    for (;;) {
      const page = await this.deliveries.listOpenByShop(
        shopId,
        SHOP_SWEEP_PAGE,
        after,
      );
      for (const delivery of page)
        await this.cancelOrFlag(
          delivery,
          {
            kind: 'system',
            actorId: null,
            reason: SYSTEM_CANCEL_REASONS.shopDeleted,
          },
          SHOP_DELETED_IN_TRANSIT_NOTE,
          counts,
          now,
        );
      if (page.length < SHOP_SWEEP_PAGE) return counts;
      after = page[page.length - 1].id;
    }
  }

  private async cancelOrFlag(
    delivery: DeliveryRecord,
    canceller: Canceller,
    inTransitNote: string,
    counts: { cancelled: number; flagged: number },
    now: Date,
  ): Promise<void> {
    if (delivery.status !== 'PICKED_UP') {
      if (await this.cancelOne(delivery.id, canceller, now)) {
        counts.cancelled++;
        return;
      }
      // It moved on between the listing and the cancel; a parcel now on its way is flagged below.
      const current = await this.deliveries.findById(delivery.id);
      if (current?.status !== 'PICKED_UP') return;
    }
    await this.deliveries.addNote(delivery.id, 'system', inTransitNote, now);
    counts.flagged++;
  }

  /**
   * `REQUESTED | OFFERED | ASSIGNED -> CANCELLED` with its effects in one transaction: a live offer is closed, an
   * assigned courier is freed. Returns `null` when the delivery was not cancellable (lost the race or already over).
   */
  private async cancelOne(
    deliveryId: string,
    canceller: Canceller,
    now: Date,
  ): Promise<TransitionedDelivery | null> {
    const outcome = await this.runner.run(async () => {
      const moved = await this.deliveries.transition({
        deliveryId,
        command: {
          type: 'cancel',
          actor: canceller.kind,
          reason: canceller.reason,
        },
        actorId: canceller.actorId,
        now,
      });
      if (!moved) return null;
      let withdrawn: string | null = null;
      let freed: string | null = null;
      if (moved.previousStatus === 'OFFERED') {
        const live = await this.offers.findLive(deliveryId);
        if (
          live &&
          (await this.offers.close(deliveryId, live.courierId, 'EXPIRED', now))
        )
          withdrawn = live.courierId;
      } else if (moved.previousStatus === 'ASSIGNED' && moved.courierId) {
        await this.couriers.markAvailable(moved.courierId);
        freed = moved.courierId;
      }
      return { moved, withdrawn, freed };
    });
    if (!outcome) return null;

    const { moved, withdrawn, freed } = outcome;
    if (withdrawn) DeliveryMetrics.offers.add(1, { outcome: 'withdrawn' });
    logDelivery(this.logger, 'log', 'delivery.cancelled', {
      deliveryId: moved.id,
      shopId: moved.shopId,
      city: moved.city,
      status: moved.previousStatus,
      ...((freed ?? withdrawn) && { courierId: (freed ?? withdrawn)! }),
    });
    await afterCommit(
      this.logger,
      'cancel',
      [
        () => this.push.status(moved),
        ...(withdrawn
          ? [
              () => this.guard.release(moved.city, withdrawn, moved.id),
              () => this.push.offerWithdrawn(withdrawn, moved.id),
            ]
          : []),
        ...(freed
          ? [
              () => this.geo.setStatus(moved.city, freed, 'AVAILABLE', null),
              () => this.push.courierCancelled(freed, moved.id),
            ]
          : []),
      ],
      { deliveryId: moved.id, city: moved.city },
    );
    return moved;
  }
}
