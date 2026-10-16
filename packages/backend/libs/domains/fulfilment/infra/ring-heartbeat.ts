import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { errorText, logDelivery } from '../application/delivery-log';
import { DeliveryOwnership } from '../application/delivery-ownership.service';
import { RING_REGISTRY, type RingRegistry } from '../domain/delivery-ports';

export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Keeps this worker instance in the ring (S20 FR-043, R-8): a beat at start, then every 10 s, and a graceful leave on
 * shutdown so the others take over the cities at once instead of after the 30 s expiry. A failed beat is logged and
 * retried at the next interval; an instance that cannot beat simply drops out of the ring after 30 s.
 */
@Injectable()
export class RingHeartbeat implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RingHeartbeat.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(RING_REGISTRY) private readonly ring: RingRegistry,
    private readonly ownership: DeliveryOwnership,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    try {
      await this.ring.leave(this.ownership.instanceId);
    } catch (error) {
      logDelivery(this.logger, 'warn', 'dispatcher.ring_leave_failed', {
        error: errorText(error),
      });
    }
  }

  /** One heartbeat; public so specs drive time by hand. */
  async beat(): Promise<void> {
    try {
      await this.ring.heartbeat(this.ownership.instanceId, this.clock.nowMs());
    } catch (error) {
      logDelivery(this.logger, 'warn', 'dispatcher.heartbeat_failed', {
        error: errorText(error),
      });
    }
  }
}
