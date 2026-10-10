import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  RESERVATION_REPOSITORY,
  RESERVATION_SOURCE,
  type ReservationRecord,
  type ReservationRepository,
  type ReservationSource,
} from '../domain/ports';
import { releasePendingGauge } from '../domain/order-metrics';
import { buildReleaseOperations } from '../domain/stock-operations';

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 10 * 60_000;

/**
 * Returns held stock after a cancel (S10 FR-030). The cancel commits `HELD → RELEASE_PENDING` with the order move; this
 * service then gives the units back through the catalog, outside any transaction. Each order's release is its own
 * operation (`orders:<id>:release:<product>`, never a replay of the reserve), so a retry after a lost answer is
 * a no-op in the catalog. A failure leaves the rows `RELEASE_PENDING` with a backoff; the release job picks them up.
 */
@Injectable()
export class ReservationReleaseService {
  private readonly logger = new Logger(ReservationReleaseService.name);

  constructor(
    @Inject(RESERVATION_REPOSITORY)
    private readonly reservations: ReservationRepository,
    @Inject(RESERVATION_SOURCE) private readonly source: ReservationSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** One immediate attempt for a freshly cancelled order. Never throws. */
  async releaseOrder(orderId: string): Promise<void> {
    try {
      const rows = (await this.reservations.forOrder(orderId)).filter(
        (r) => r.status === 'RELEASE_PENDING',
      );
      await this.releaseGroup(orderId, rows);
    } catch (error) {
      this.logger.warn(
        `release of order ${orderId} failed: ${(error as Error).name}`,
      );
    }
    await this.refreshGauge();
  }

  /** The release job: due `RELEASE_PENDING` rows (≤ `limit`), one catalog call per order. Returns how many were released. */
  async processDue(limit: number): Promise<number> {
    const due = await this.reservations.releasePending(this.clock.now(), limit);
    const byOrder = new Map<string, ReservationRecord[]>();
    for (const r of due)
      byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
    let released = 0;
    for (const [orderId, rows] of byOrder) {
      try {
        released += await this.releaseGroup(orderId, rows);
      } catch (error) {
        this.logger.warn(
          `release of order ${orderId} failed: ${(error as Error).name}`,
        );
      }
    }
    await this.refreshGauge();
    return released;
  }

  private async releaseGroup(
    orderId: string,
    rows: ReservationRecord[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    try {
      const outcome = await this.source.release(
        buildReleaseOperations(
          orderId,
          rows.map((r) => ({
            productId: r.productId,
            shopId: r.shopId,
            quantity: r.quantity,
          })),
        ),
      );
      if (outcome.outcome === 'rejected')
        // a product that no longer exists has no stock to return; nothing else can reject a positive delta
        this.logger.warn(
          `release of order ${orderId}: catalog rejected ${outcome.unavailable.length} products`,
        );
    } catch (error) {
      const now = this.clock.now();
      for (const r of rows) {
        const attempts = r.releaseAttempts + 1;
        const delay = Math.min(
          MAX_BACKOFF_MS,
          BASE_BACKOFF_MS * 2 ** (attempts - 1),
        );
        await this.reservations.scheduleRetry(
          r.id,
          attempts,
          new Date(now.getTime() + delay),
        );
      }
      throw error;
    }
    for (const r of rows) await this.reservations.markReleased(r.id);
    return rows.length;
  }

  async refreshGauge(): Promise<void> {
    releasePendingGauge.set(await this.reservations.countReleasePending());
  }
}
