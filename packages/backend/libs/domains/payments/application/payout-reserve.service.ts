import { Inject, Injectable } from '@nestjs/common';
import type { PayoutReserveView } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { ShopNotFound } from '../domain/payout-errors';
import {
  PAYOUT_RESERVE_REPOSITORY,
  SHOP_SUMMARY_PORT,
  type PayoutReserveRepository,
  type ReserveRecord,
  type ShopSummaryPort,
} from '../domain/payout-ports';
import { MAX_RESERVE_BPS } from '../domain/reserve';

const view = (r: ReserveRecord): PayoutReserveView => ({
  shopId: r.shopId,
  reserveBps: r.reserveBps,
  reason: r.reason,
  updatedBy: r.updatedBy,
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * An operator sets a shop's reserve (S15 FR-040, FR-041): basis points 0..5000 with a reason, one history row per
 * effective change. It applies to payouts created afterwards, never to existing ones.
 */
@Injectable()
export class PayoutReserveService {
  constructor(
    @Inject(PAYOUT_RESERVE_REPOSITORY)
    private readonly reserves: PayoutReserveRepository,
    @Inject(SHOP_SUMMARY_PORT) private readonly shops: ShopSummaryPort,
    private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async set(
    shopId: string,
    reserveBps: number,
    reason: string,
    actor: string,
  ): Promise<PayoutReserveView> {
    if (
      !Number.isInteger(reserveBps) ||
      reserveBps < 0 ||
      reserveBps > MAX_RESERVE_BPS
    )
      throw new RangeError('reserveBps out of range');
    if (!(await this.shops.getSummaries([shopId])).has(shopId))
      throw new ShopNotFound();
    return this.runner.run(async (tx) =>
      view(
        await this.reserves.save(
          {
            shopId,
            reserveBps,
            reason,
            updatedBy: actor,
            updatedAt: this.clock.now(),
          },
          tx,
        ),
      ),
    );
  }
}
