import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DeliveryCourierView } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  COURIER_REPOSITORY,
  DELIVERY_REPOSITORY,
  DISPATCH_TIMERS,
  GEO_INDEX,
  OFFER_GUARD,
  OFFER_REPOSITORY,
  type CourierOfflineHook,
  type CourierRepository,
  type DeliveryRecord,
  type DeliveryRepository,
  type DispatchTimers,
  type GeoHit,
  type GeoIndex,
  type OfferGuard,
  type OfferRecord,
  type OfferRepository,
} from '../domain/delivery-ports';
import {
  MAX_ATTEMPTS,
  OFFER_GUARD_TTL_MS,
  OFFER_LAPSE_DETAILS,
  OFFER_TTL_MS,
  RETRY_DELAY_MS,
  SYSTEM_CANCEL_REASONS,
} from '../domain/dispatch-rules';
import { isEligible } from '../domain/courier-eligibility';
import {
  rankCandidates,
  SEARCH_RADII_M,
  MAX_CANDIDATES,
} from '../domain/candidate-ranking';
import {
  CourierBusyError,
  DeliveryNotFoundError,
  InvalidDeliveryTransitionError,
  OfferExpiredError,
  OfferNotActiveError,
} from '../domain/delivery-errors';
import { toCourierView } from '../domain/delivery-views';
import { DeliveryMetrics } from './delivery-metrics';
import { afterCommit } from './after-commit';
import { logDelivery } from './delivery-log';
import { DeliveryPushService } from './delivery-push.service';
import { OrderWriteBackScheduler } from './order-lifecycle.service';
import type { OfferTimeoutMessage } from '@marketplace-sandbox/contracts';

export type DispatchOutcome =
  'offered' | 'retry_scheduled' | 'cancelled' | 'stale';

/** Why an offer ends without the courier answering. */
export type LapseReason = 'timeout' | 'courier_offline';

/** The offer insert lost to the store of record: roll back the transition that came with it. */
class LostOfferRace extends Error {
  constructor() {
    super(
      'the courier already holds a live offer or was offered this delivery',
    );
    this.name = 'LostOfferRace';
  }
}

/**
 * Dispatch (S20 FR-013..FR-021, FR-026): searches the eligible couriers around the pickup in widening radii and offers
 * the delivery to one at a time. The store of record is Postgres: an offer is the `DeliveryOffer` row plus the
 * `REQUESTED -> OFFERED` move in ONE transaction, and the partial unique indexes refuse a second live offer per courier
 * or a second assignment, whatever the Redis index or the cache guard say. Every move is a conditional write that
 * holds the delivery row first (so accept, decline, timeouts, cancels and offers queue behind each other on one lock
 * order); timers, pushes, cache mirrors and the order write-back run after the commit and are repaired by the
 * recovery job (`nextActionAt` is stored on the delivery).
 */
@Injectable()
export class DispatchService implements CourierOfflineHook {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    @Inject(DELIVERY_REPOSITORY)
    private readonly deliveries: DeliveryRepository,
    @Inject(OFFER_REPOSITORY) private readonly offers: OfferRepository,
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(GEO_INDEX) private readonly geo: GeoIndex,
    @Inject(OFFER_GUARD) private readonly guard: OfferGuard,
    @Inject(DISPATCH_TIMERS) private readonly timers: DispatchTimers,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: TransactionRunner,
    private readonly push: DeliveryPushService,
    private readonly writeBack: OrderWriteBackScheduler,
  ) {}

  // ----------------------------------------------------------- dispatch

  /** One dispatch step of a `REQUESTED` delivery: offer, schedule a retry, or give up (FR-013, FR-019). */
  async dispatch(
    deliveryId: string,
    now: Date = this.clock.now(),
  ): Promise<DispatchOutcome> {
    const delivery = await this.deliveries.findById(deliveryId);
    if (!delivery || delivery.status !== 'REQUESTED') return 'stale';
    if (delivery.attempt >= MAX_ATTEMPTS) return this.giveUp(delivery, now);
    if (await this.offerToNext(delivery, now)) return 'offered';
    return this.scheduleRetry(delivery, now);
  }

  /** The delivery used its attempts: it is cancelled and the buyer is told (AS-20). */
  private async giveUp(
    delivery: DeliveryRecord,
    now: Date,
  ): Promise<DispatchOutcome> {
    const moved = await this.runner.run(() =>
      this.deliveries.transition({
        deliveryId: delivery.id,
        expectedVersion: delivery.version,
        command: {
          type: 'cancel',
          actor: 'system',
          reason: SYSTEM_CANCEL_REASONS.noCourier,
        },
        actorId: null,
        now,
      }),
    );
    if (!moved) return 'stale';
    DeliveryMetrics.giveUps.add(1, { city: delivery.city });
    logDelivery(this.logger, 'log', 'delivery.gave_up', {
      deliveryId: delivery.id,
      city: delivery.city,
      attempt: delivery.attempt,
    });
    await afterCommit(this.logger, 'give up', [() => this.push.status(moved)], {
      deliveryId: delivery.id,
      city: delivery.city,
    });
    return 'cancelled';
  }

  /** Nobody could be offered: the attempt is consumed and the retry due time stored in one conditional update. */
  private async scheduleRetry(
    delivery: DeliveryRecord,
    now: Date,
  ): Promise<DispatchOutcome> {
    const row = await this.deliveries.consumeEmptySearch(
      delivery.id,
      delivery.attempt,
      new Date(now.getTime() + RETRY_DELAY_MS),
      now,
    );
    if (!row) return 'stale';
    DeliveryMetrics.dispatchAttempts.add(1, {
      city: delivery.city,
      result: 'no_candidate',
    });
    await afterCommit(
      this.logger,
      'retry timer',
      [
        () =>
          this.timers.enqueue(
            {
              deliveryId: row.id,
              city: row.city,
              courierId: '',
              attempt: row.attempt,
            },
            RETRY_DELAY_MS / 1000,
          ),
      ],
      { deliveryId: row.id, city: row.city },
    );
    return 'retry_scheduled';
  }

  /** True when a courier got the offer. A delivery that moved on meanwhile ends the search as not offered. */
  private async offerToNext(
    delivery: DeliveryRecord,
    now: Date,
  ): Promise<boolean> {
    const offeredBefore = await this.offers.offeredCourierIds(delivery.id);
    const tried = new Set<string>();
    for (const radiusM of SEARCH_RADII_M) {
      const hits = await this.geo.search(
        delivery.city,
        delivery.pickup,
        radiusM,
        MAX_CANDIDATES,
      );
      const fresh = hits.filter(
        (h) => !tried.has(h.courierId) && !offeredBefore.has(h.courierId),
      );
      const eligible = await this.eligible(fresh, now, offeredBefore);
      for (const candidate of rankCandidates(eligible, MAX_CANDIDATES)) {
        tried.add(candidate.courierId);
        const result = await this.tryOffer(delivery, candidate.courierId, now);
        if (result === 'offered') return true;
        if (result === 'stale') return false;
      }
    }
    return false;
  }

  /** Eligibility judged on the stored status and offers, not on the index that found the courier (A7, A11). */
  private async eligible(
    hits: readonly GeoHit[],
    now: Date,
    offeredBefore: ReadonlySet<string>,
  ): Promise<GeoHit[]> {
    if (hits.length === 0) return [];
    const ids = hits.map((h) => h.courierId);
    const [stored, live] = await Promise.all([
      this.couriers.findMany(ids),
      this.offers.withLiveOffer(ids),
    ]);
    const status = new Map(stored.map((c) => [c.id, c.status]));
    return hits.filter((hit) =>
      isEligible(
        {
          courierId: hit.courierId,
          status: status.get(hit.courierId) ?? 'OFFLINE',
          positionTs: hit.positionTs > 0 ? hit.positionTs : null,
          hasLiveOffer: live.has(hit.courierId),
        },
        now.getTime(),
        offeredBefore,
      ),
    );
  }

  private async tryOffer(
    delivery: DeliveryRecord,
    courierId: string,
    now: Date,
  ): Promise<'offered' | 'lost' | 'stale'> {
    if (
      !(await this.guard.tryAcquire(
        delivery.city,
        courierId,
        delivery.id,
        OFFER_GUARD_TTL_MS,
      ))
    ) {
      DeliveryMetrics.dispatchAttempts.add(1, {
        city: delivery.city,
        result: 'lost_race',
      });
      return 'lost';
    }
    const attempt = delivery.attempt + 1;
    const expiresAt = new Date(now.getTime() + OFFER_TTL_MS);
    let offered: { delivery: DeliveryRecord; offer: OfferRecord } | null;
    try {
      offered = await this.runner.run(async () => {
        const moved = await this.deliveries.transition({
          deliveryId: delivery.id,
          expectedVersion: delivery.version,
          command: { type: 'offer', actor: 'system', courierId },
          actorId: courierId,
          now,
          set: { attempt, nextActionAt: expiresAt },
        });
        if (!moved) return null;
        const offer = await this.offers.insertOffer({
          deliveryId: delivery.id,
          courierId,
          attempt,
          offeredAt: now,
          expiresAt,
        });
        if (!offer) throw new LostOfferRace();
        return { delivery: moved, offer };
      });
    } catch (error) {
      await this.guard.release(delivery.city, courierId, delivery.id);
      if (error instanceof LostOfferRace) {
        DeliveryMetrics.dispatchAttempts.add(1, {
          city: delivery.city,
          result: 'lost_race',
        });
        return 'lost';
      }
      throw error;
    }
    if (!offered) {
      await this.guard.release(delivery.city, courierId, delivery.id);
      return 'stale';
    }

    DeliveryMetrics.offers.add(1, { outcome: 'offered' });
    DeliveryMetrics.dispatchAttempts.add(1, {
      city: delivery.city,
      result: 'offered',
    });
    const { delivery: moved, offer } = offered;
    logDelivery(this.logger, 'log', 'delivery.offered', {
      deliveryId: moved.id,
      courierId,
      city: moved.city,
      attempt: offer.attempt,
    });
    await afterCommit(
      this.logger,
      'offer',
      [
        () =>
          this.timers.enqueue(
            {
              deliveryId: moved.id,
              city: moved.city,
              courierId,
              attempt: offer.attempt,
            },
            OFFER_TTL_MS / 1000,
          ),
        () => this.push.offer(moved, offer),
        () => this.push.status(moved),
      ],
      { deliveryId: moved.id, courierId, city: moved.city },
    );
    return 'offered';
  }

  // ------------------------------------------------------------- accept

  /**
   * Accept (R-3): the delivery row is locked first, then ONE transaction records the offer `ACCEPTED`, the delivery
   * `ASSIGNED` to the courier and the courier `BUSY`. The same courier repeating it gets the same answer (FR-025); an
   * offer the clock says is over answers `offer_expired` and the timer then moves the delivery on (R-4).
   */
  async accept(
    deliveryId: string,
    courierId: string,
    now: Date = this.clock.now(),
  ): Promise<DeliveryCourierView> {
    const outcome = await this.runner.run(async () => {
      const current = await this.deliveries.findById(deliveryId, {
        forUpdate: true,
      });
      if (!current) throw new DeliveryNotFoundError();
      const result = await this.offers.accept(deliveryId, courierId, now);
      if (result.outcome === 'expired') throw new OfferExpiredError();
      if (result.outcome === 'not_active') {
        // Never offered: the delivery does not exist for this caller.
        if (!result.previous) throw new DeliveryNotFoundError();
        if (
          result.previous.status === 'ACCEPTED' &&
          current.status === 'ASSIGNED' &&
          current.courierId === courierId
        )
          return { replay: true as const, delivery: current };
        if (current.status !== 'OFFERED' && current.status !== 'REQUESTED')
          throw new InvalidDeliveryTransitionError(current.status, 'accept');
        throw new OfferNotActiveError();
      }
      const moved = await this.deliveries.transition({
        deliveryId,
        command: { type: 'accept', actor: 'courier', courierId },
        actorId: courierId,
        now,
      });
      if (!moved)
        throw new InvalidDeliveryTransitionError(current.status, 'accept');
      if (!(await this.couriers.markBusy(courierId)))
        throw new CourierBusyError();
      return { replay: false as const, delivery: moved };
    });
    if (outcome.replay) return toCourierView(outcome.delivery, null);

    const { delivery } = outcome;
    DeliveryMetrics.offers.add(1, { outcome: 'accepted' });
    logDelivery(this.logger, 'log', 'delivery.accepted', {
      deliveryId,
      courierId,
      city: delivery.city,
      attempt: delivery.attempt,
    });
    DeliveryMetrics.requestToAssignment.record(
      Math.max(0, (now.getTime() - delivery.createdAt.getTime()) / 1000),
    );
    await afterCommit(
      this.logger,
      'accept',
      [
        () => this.geo.setStatus(delivery.city, courierId, 'BUSY', delivery.id),
        () => this.guard.release(delivery.city, courierId, delivery.id),
        () => this.push.status(delivery),
        () => this.writeBack.schedule(delivery),
      ],
      { deliveryId, courierId, city: delivery.city },
    );
    return toCourierView(delivery, null);
  }

  // ------------------------------------------------------------ decline

  /** Decline: the offer is `DECLINED`, the courier excluded for good, and the next courier is offered at once. */
  async decline(
    deliveryId: string,
    courierId: string,
    now: Date = this.clock.now(),
  ): Promise<void> {
    const moved = await this.runner.run(async () => {
      const current = await this.deliveries.findById(deliveryId, {
        forUpdate: true,
      });
      if (!current) throw new DeliveryNotFoundError();
      const offer = await this.offers.findForCourier(deliveryId, courierId);
      if (!offer) throw new DeliveryNotFoundError();
      if (offer.status === 'DECLINED') return null; // repeating an applied decline is a success (FR-025)
      if (offer.status !== 'OFFERED') {
        if (current.status !== 'OFFERED' && current.status !== 'REQUESTED')
          throw new InvalidDeliveryTransitionError(current.status, 'decline');
        throw new OfferNotActiveError();
      }
      const closed = await this.offers.close(
        deliveryId,
        courierId,
        'DECLINED',
        now,
      );
      const lapsed = closed
        ? await this.deliveries.transition({
            deliveryId,
            command: { type: 'offerLapsed', actor: 'courier' },
            actorId: courierId,
            detail: OFFER_LAPSE_DETAILS.declined,
            now,
            set: { nextActionAt: now },
          })
        : null;
      if (!lapsed)
        throw new InvalidDeliveryTransitionError(current.status, 'decline');
      return { delivery: lapsed, courierId, city: current.city };
    });
    if (!moved) return;

    DeliveryMetrics.offers.add(1, { outcome: 'declined' });
    logDelivery(this.logger, 'log', 'delivery.declined', {
      deliveryId,
      courierId,
      city: moved.city,
    });
    await afterCommit(
      this.logger,
      'decline',
      [
        () => this.guard.release(moved.city, courierId, deliveryId),
        () => this.push.status(moved.delivery),
      ],
      { deliveryId, courierId, city: moved.city },
    );
    await this.dispatch(deliveryId, now);
  }

  // ----------------------------------------------------------- timeouts

  /**
   * A timer message from `delivery-offer-timeouts` (or a replay of one). `courierId = ''` is "retry dispatch". Stale and
   * duplicate messages are no-ops: wrong attempt, wrong courier, the offer already answered, the delivery moved on.
   */
  async onTimer(
    message: OfferTimeoutMessage,
    now: Date = this.clock.now(),
  ): Promise<void> {
    if (!message.courierId) {
      const delivery = await this.deliveries.findById(message.deliveryId);
      if (
        !delivery ||
        delivery.status !== 'REQUESTED' ||
        delivery.attempt !== message.attempt
      )
        return;
      await this.dispatch(delivery.id, now);
      return;
    }
    await this.expireOffer(
      {
        deliveryId: message.deliveryId,
        courierId: message.courierId,
        attempt: message.attempt,
        reason: 'timeout',
      },
      now,
    );
  }

  /**
   * Ends a live offer without an answer and dispatches the delivery to the next courier. `timeout` acts only when the
   * offer is over by `now`; `courier_offline` acts at once. Returns whether anything changed.
   */
  async expireOffer(
    input: {
      deliveryId: string;
      courierId: string;
      attempt?: number;
      reason: LapseReason;
    },
    now: Date = this.clock.now(),
  ): Promise<boolean> {
    const lapsed = await this.runner.run(async () => {
      const current = await this.deliveries.findById(input.deliveryId, {
        forUpdate: true,
      });
      if (!current || current.status !== 'OFFERED') return null;
      const offer = await this.offers.findLive(input.deliveryId);
      if (
        !offer ||
        offer.courierId !== input.courierId ||
        (input.attempt !== undefined && offer.attempt !== input.attempt)
      )
        return null;
      if (
        input.reason === 'timeout' &&
        offer.expiresAt.getTime() > now.getTime()
      )
        return null;
      const closed = await this.offers.close(
        input.deliveryId,
        input.courierId,
        'EXPIRED',
        now,
      );
      if (!closed) return null;
      const moved = await this.deliveries.transition({
        deliveryId: input.deliveryId,
        command: { type: 'offerLapsed', actor: 'system' },
        actorId: null,
        detail:
          OFFER_LAPSE_DETAILS[
            input.reason === 'timeout' ? 'timeout' : 'courierOffline'
          ],
        now,
        set: { nextActionAt: now },
      });
      if (!moved) throw new Error('offer closed but the delivery did not move');
      return moved;
    });
    if (!lapsed) return false;

    DeliveryMetrics.offers.add(1, {
      outcome: input.reason === 'timeout' ? 'expired' : 'withdrawn',
    });
    logDelivery(this.logger, 'log', 'delivery.offer_lapsed', {
      deliveryId: lapsed.id,
      courierId: input.courierId,
      city: lapsed.city,
      status: input.reason,
    });
    await afterCommit(
      this.logger,
      'offer lapse',
      [
        () => this.guard.release(lapsed.city, input.courierId, lapsed.id),
        () => this.push.offerWithdrawn(input.courierId, lapsed.id),
        () => this.push.status(lapsed),
      ],
      { deliveryId: lapsed.id, courierId: input.courierId, city: lapsed.city },
    );
    await this.dispatch(lapsed.id, now);
    return true;
  }

  /**
   * The courier went `OFFLINE` (FR-003, AS-26): a live offer is withdrawn and the delivery goes to the next courier at
   * once. `CourierService` calls this after the shift change committed.
   */
  async onCourierOffline(courierId: string): Promise<void> {
    // Any `OFFERED` record counts, whether the clock has passed its expiry or not.
    const offer = await this.offers.findLiveForCourier(courierId, new Date(0));
    if (!offer) return;
    await this.expireOffer({
      deliveryId: offer.deliveryId,
      courierId,
      attempt: offer.attempt,
      reason: 'courier_offline',
    });
  }
}
