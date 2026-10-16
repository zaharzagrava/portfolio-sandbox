import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  COURIER_REPOSITORY,
  DELIVERY_REPOSITORY,
  GEO_INDEX,
  OFFER_REPOSITORY,
  type CourierRepository,
  type DeliveryRepository,
  type GeoIndex,
  type OfferRepository,
} from '../domain/delivery-ports';
import { POSITION_MAX_AGE_MS } from '../domain/courier-eligibility';
import { RECOVERY_BATCH, RECOVERY_LEASE_MS } from '../domain/dispatch-rules';
import { cityLabel, DeliveryMetrics } from './delivery-metrics';
import { errorText, logDelivery } from './delivery-log';
import { DeliveryOwnership } from './delivery-ownership.service';
import { DispatchService } from './dispatch.service';
import { OrderWriteBackScheduler } from './order-lifecycle.service';

export interface RecoveryResult {
  /** Overdue offers expired like the timer would have. */
  offerExpiries: number;
  /** Overdue `REQUESTED` deliveries dispatched. */
  dispatchRetries: number;
  /** Write-back jobs (re)queued for deliveries ahead of `orderSyncedStatus`. */
  writeBacks: number;
  /** Index members dropped because their position is older than the eligibility window. */
  pruned: number;
  /** Couriers found with more than one live offer or active assignment (must be 0). */
  doubleAssignments: number;
}

/**
 * The safety net under the timers (S20 FR-018, R-2, SC-004): a lost or late queue message delays a delivery but never
 * strands it, because the due time is stored on the row. Each tick claims at most 100 overdue deliveries, one short
 * transaction each (`FOR UPDATE SKIP LOCKED`, the due time pushed 30 s ahead as a lease), and acts on them OUTSIDE
 * that transaction, where the Redis search and the pushes may run; the conditional moves of `DispatchService` make a
 * concurrent timer message or a second tick harmless. The tick also re-drives the order write-back, drops stale index
 * members and counts impossible states.
 */
@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    @Inject(DELIVERY_REPOSITORY)
    private readonly deliveries: DeliveryRepository,
    @Inject(OFFER_REPOSITORY) private readonly offers: OfferRepository,
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(GEO_INDEX) private readonly geo: GeoIndex,
    private readonly dispatch: DispatchService,
    private readonly writeBack: OrderWriteBackScheduler,
    private readonly runner: TransactionRunner,
    private readonly ownership: DeliveryOwnership,
  ) {}

  /**
   * The whole tick for the cities this instance owns (`ownedCities` undefined), or for the given ones (`null` = every
   * city): the per-city work of `recoverCities`, then the work that belongs to no city (write-back re-drive and the
   * double-assignment count).
   */
  async recoverOverdue(
    now: Date,
    ownedCities?: readonly string[] | null,
  ): Promise<RecoveryResult> {
    const result = await this.recoverCities(now, ownedCities);

    for (const delivery of await this.deliveries.listNeedingOrderSync(
      RECOVERY_BATCH,
    )) {
      await this.writeBack.schedule(delivery);
      result.writeBacks++;
    }

    result.doubleAssignments = await this.deliveries.countDoubleAssignments();
    if (result.doubleAssignments > 0) {
      DeliveryMetrics.doubleAssignments.add(result.doubleAssignments);
      logDelivery(this.logger, 'error', 'delivery.double_assignment', {
        error: `${result.doubleAssignments} couriers hold more than one live offer or assignment`,
      });
    }
    return result;
  }

  /**
   * The per-city part of the tick: overdue offers and retries of the cities, and the stale members of their live
   * indexes. `ownedCities` undefined = the cities this instance owns now, `null` = every city. A failure in one city is
   * counted for that city and never stops another.
   */
  async recoverCities(
    now: Date,
    ownedCities?: readonly string[] | null,
  ): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      offerExpiries: 0,
      dispatchRetries: 0,
      writeBacks: 0,
      pruned: 0,
      doubleAssignments: 0,
    };
    if (ownedCities === undefined)
      ownedCities = await this.ownership.ownedCities(
        await this.couriers.listCities(),
      );

    for (let i = 0; i < RECOVERY_BATCH; i++) {
      const claimed = await this.runner.run(async () => {
        const delivery = await this.deliveries.lockNextOverdue(
          now,
          ownedCities,
        );
        if (delivery)
          await this.deliveries.deferAction(
            delivery.id,
            new Date(now.getTime() + RECOVERY_LEASE_MS),
          );
        return delivery;
      });
      if (!claimed) break;
      try {
        if (claimed.status === 'OFFERED') {
          const live = await this.offers.findLive(claimed.id);
          if (!live) {
            logDelivery(
              this.logger,
              'error',
              'delivery.offered_without_offer',
              {
                deliveryId: claimed.id,
                city: claimed.city,
              },
            );
            continue;
          }
          const acted = await this.dispatch.expireOffer(
            {
              deliveryId: claimed.id,
              courierId: live.courierId,
              attempt: live.attempt,
              reason: 'timeout',
            },
            now,
          );
          if (acted) {
            result.offerExpiries++;
            DeliveryMetrics.recoveredTimers.add(1, { kind: 'offer_expiry' });
          }
        } else {
          await this.dispatch.dispatch(claimed.id, now);
          result.dispatchRetries++;
          DeliveryMetrics.recoveredTimers.add(1, { kind: 'dispatch_retry' });
        }
      } catch (error) {
        // The lease keeps this row out of the next tick for a while; the next one retries it.
        DeliveryMetrics.dispatchFailures.add(1, {
          city: cityLabel(claimed.city),
        });
        logDelivery(this.logger, 'error', 'delivery.recovery_failed', {
          deliveryId: claimed.id,
          city: claimed.city,
          status: claimed.status,
          error: errorText(error),
        });
      }
    }

    result.pruned = await this.pruneIndex(now, ownedCities);
    return result;
  }

  private async pruneIndex(
    now: Date,
    ownedCities: readonly string[] | null,
  ): Promise<number> {
    let cities: string[];
    try {
      cities = (await this.couriers.listCities()).filter(
        (city) => !ownedCities || ownedCities.includes(city),
      );
    } catch (error) {
      logDelivery(this.logger, 'warn', 'courier.index_not_pruned', {
        error: errorText(error),
      });
      return 0;
    }
    let pruned = 0;
    for (const city of cities) {
      try {
        pruned += await this.geo.pruneStale(
          city,
          now.getTime() - POSITION_MAX_AGE_MS,
        );
      } catch (error) {
        DeliveryMetrics.dispatchFailures.add(1, { city: cityLabel(city) });
        logDelivery(this.logger, 'warn', 'courier.index_not_pruned', {
          city,
          error: errorText(error),
        });
      }
    }
    return pruned;
  }
}
