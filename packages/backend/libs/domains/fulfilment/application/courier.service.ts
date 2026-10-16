import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  CourierSelf,
  CourierView,
  RegisterCourierRequest,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { errorText, logDelivery } from './delivery-log';
import {
  COURIER_OFFLINE_HOOK,
  COURIER_REPOSITORY,
  GEO_INDEX,
  type CourierOfflineHook,
  type CourierRecord,
  type CourierRepository,
  type GeoIndex,
} from '../domain/delivery-ports';
import {
  CourierBusyError,
  CourierProfileRequiredError,
} from '../domain/delivery-errors';

export const toCourierView = (c: CourierRecord): CourierView => ({
  id: c.id,
  city: c.city,
  vehicle: c.vehicle,
  status: c.status,
});

/**
 * Courier profile and shift (S20 FR-001..FR-004). No SQL, no Redis client: the repository and the live index are ports.
 * `BUSY` is never set here; the delivery moves do it (A8, A18).
 */
@Injectable()
export class CourierService {
  private readonly logger = new Logger(CourierService.name);

  constructor(
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(GEO_INDEX) private readonly geo: GeoIndex,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional()
    @Inject(COURIER_OFFLINE_HOOK)
    private readonly offlineHook?: CourierOfflineHook,
  ) {}

  /** `created` tells the controller to answer 201 instead of 200. */
  async register(
    userId: string,
    input: RegisterCourierRequest,
  ): Promise<{ created: boolean; courier: CourierView }> {
    const { outcome, courier, previousCity } = await this.couriers.register(
      userId,
      input.city,
      input.vehicle,
      this.clock.now(),
    );
    if (outcome === 'busy') throw new CourierBusyError();
    if (previousCity) {
      // The cell moved: the old city's entries are derived state and go; the new city learns the status.
      await this.mirror(() => this.geo.removeSearchable(previousCity, userId));
      await this.mirror(() =>
        this.geo.setStatus(courier.city, userId, courier.status, null),
      );
    }
    return { created: outcome === 'created', courier: toCourierView(courier) };
  }

  /** Shift start and end. Repeating a switch is a no-op that still repairs the live mirror. */
  async setAvailability(
    userId: string,
    available: boolean,
  ): Promise<CourierView> {
    const result = await this.couriers.setAvailability(userId, available);
    if (!result) throw new CourierProfileRequiredError();
    if (result.outcome === 'busy') throw new CourierBusyError();
    const { courier } = result;
    await this.mirror(() =>
      this.geo.setStatus(courier.city, courier.id, courier.status, null),
    );
    if (!available && result.outcome === 'changed')
      await this.offlineHook?.onCourierOffline(courier.id);
    return toCourierView(courier);
  }

  async getSelf(userId: string): Promise<CourierSelf> {
    const self = await this.couriers.selfView(userId, this.clock.now());
    if (!self) throw new CourierProfileRequiredError();
    return {
      ...toCourierView(self.courier),
      ...(self.liveOffer && {
        currentOffer: {
          deliveryId: self.liveOffer.deliveryId,
          pickup: self.liveOffer.pickup,
          dropoff: self.liveOffer.dropoff,
          feeMinor: self.liveOffer.feeMinor,
          currency: self.liveOffer.currency,
          expiresAt: self.liveOffer.expiresAt.toISOString(),
        },
      }),
      ...(self.activeDelivery && { activeDelivery: self.activeDelivery }),
    };
  }

  /** The stored profile, or `courier_profile_required` (session-derived identity: the id is the user's). */
  async requireProfile(userId: string): Promise<CourierRecord> {
    const courier = await this.couriers.find(userId);
    if (!courier) throw new CourierProfileRequiredError();
    return courier;
  }

  /**
   * The live mirror is derived state: the stored status is already committed, so a failing cache is logged and the next
   * ping or shift change repairs it (the answer must not depend on it).
   */
  private async mirror(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      logDelivery(this.logger, 'warn', 'courier.mirror_failed', {
        error: errorText(error),
      });
    }
  }
}
