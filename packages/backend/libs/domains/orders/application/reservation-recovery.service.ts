import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ORDER_REPOSITORY, type OrderRepository } from '../domain/ports';
import { reservationExpiredCounter } from '../domain/order-metrics';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderReservationService } from './order-reservation.service';

/**
 * Keeps holds honest (S10 FR-027 to FR-029): cancels holds that ended without payment, and finishes checkouts whose
 * process died between the order write and the stock answer. Every step is a conditional move, so jobs may overlap, run
 * twice or on two instances: the second finds nothing to do.
 */
@Injectable()
export class ReservationRecoveryService {
  private readonly logger = new Logger(ReservationRecoveryService.name);

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    private readonly lifecycle: OrderLifecycleService,
    private readonly reservation: OrderReservationService,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The per-order expiry job: no-op before the deadline, after payment or after a cancel. */
  async expire(orderId: string): Promise<boolean> {
    const order = await this.orders.findById(orderId);
    if (
      !order ||
      order.status !== 'RESERVED' ||
      !order.reservedUntil ||
      order.reservedUntil.getTime() > this.clock.now().getTime()
    )
      return false;
    const result = await this.lifecycle.transition(
      orderId,
      { type: 'cancel', reason: 'hold_expired' },
      { actor: 'system:expiry' },
    );
    if (result.kind === 'applied') reservationExpiredCounter.add();
    return result.kind === 'applied';
  }

  /** The sweeper: holds past their deadline whose expiry job was lost, at most `limit` per run. */
  async sweepExpired(
    limit = this.config.get('orders_sweeper_batch'),
  ): Promise<number> {
    const ids = await this.orders.expiredReserved(this.clock.now(), limit);
    let cancelled = 0;
    for (const id of ids) {
      try {
        if (await this.expire(id)) cancelled += 1;
      } catch (error) {
        this.logger.warn(
          `sweeper: order ${id} not expired: ${(error as Error).name}`,
        );
      }
    }
    return cancelled;
  }

  /** Recovery of `PENDING` orders older than the recovery age: repeat the stock step with the same operation ids. */
  async recoverPending(limit = 100): Promise<number> {
    const before = new Date(
      this.clock.now().getTime() -
        this.config.get('orders_recovery_age_seconds') * 1000,
    );
    const ids = await this.orders.stalePending(before, limit);
    let resolved = 0;
    for (const id of ids) {
      try {
        const outcome = await this.reservation.reserve(id, 'system:recovery');
        if (outcome.kind !== 'gone') resolved += 1;
      } catch (error) {
        this.logger.warn(
          `recovery: order ${id} still pending: ${(error as Error).name}`,
        );
      }
    }
    return resolved;
  }
}
