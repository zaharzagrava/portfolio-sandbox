import { Inject, Injectable } from '@nestjs/common';
import type { PayoutDestinationView } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  effectiveFromFor,
  maskDestination,
  validateDestination,
} from '../domain/destination';
import { DestinationInvalid, ShopNotFound } from '../domain/payout-errors';
import {
  PAYOUT_DESTINATION_REPOSITORY,
  SHOP_SUMMARY_PORT,
  type DestinationRecord,
  type PayoutDestinationRepository,
  type ShopSummaryPort,
} from '../domain/payout-ports';

const HOUR_MS = 3_600_000;

const view = (d: DestinationRecord): PayoutDestinationView => ({
  shopId: d.shopId,
  providerAccountId: maskDestination(d.providerAccountId),
  status: 'ACTIVE',
  effectiveFrom: d.effectiveFrom.toISOString(),
  changedAt: d.changedAt.toISOString(),
});

/**
 * An operator sets where a shop's payouts go (S15 FR-028…FR-030). A first destination counts at once; a different one
 * after the cooling period (the shop is skipped meanwhile, never paid to the old account); the same value writes
 * nothing. The full account id is stored once and returned only masked.
 */
@Injectable()
export class PayoutDestinationService {
  constructor(
    @Inject(PAYOUT_DESTINATION_REPOSITORY)
    private readonly destinations: PayoutDestinationRepository,
    @Inject(SHOP_SUMMARY_PORT) private readonly shops: ShopSummaryPort,
    private readonly runner: TransactionRunner,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async set(
    shopId: string,
    providerAccountId: string,
    actor: string,
  ): Promise<PayoutDestinationView> {
    if (!validateDestination(providerAccountId)) throw new DestinationInvalid();
    if (!(await this.shops.getSummaries([shopId])).has(shopId))
      throw new ShopNotFound();

    return this.runner.run(async (tx) => {
      const now = this.clock.now();
      const existing = await this.destinations.find(shopId, tx);
      const effectiveFrom = effectiveFromFor(
        existing?.providerAccountId ?? null,
        providerAccountId,
        now,
        this.config.get('payout_destination_cooling_hours') * HOUR_MS,
      );
      if (effectiveFrom === null) return view(existing!);
      const saved = await this.destinations.save(
        {
          shopId,
          providerAccountId,
          effectiveFrom,
          changedAt: now,
          changedBy: actor,
        },
        existing ? maskDestination(existing.providerAccountId) : null,
        maskDestination(providerAccountId),
        tx,
      );
      return view(saved);
    });
  }
}
