import { Inject, Injectable } from '@nestjs/common';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { SinkCounts } from '@app/infrastructure/projections/projector';
import { toBasket } from '../domain/basket';
import {
  parsePaidOrder,
  type PaidOrder,
} from '../domain/recommendation-events';
import {
  BASKET_STORE,
  type BasketRow,
  type BasketStore,
} from '../domain/recommendation-ports';
import {
  recommendationsBasketSkipped,
  recommendationsBaskets,
} from '../infra/recommendations-metrics';
import { RecommendationsSettings } from '../infra/recommendations-config';

export interface PaidOrderEvent {
  aggregateId: string;
  payload: unknown;
}

/**
 * Projector use case (S34 FR-013 to FR-015): one basket per `orderId`, written only when its `orderVersion` is strictly
 * higher than the stored one (`versionGuard`). A batch is validated whole before anything is written, so a poison order
 * throws a `PermanentError` with no side effect and the framework retries its neighbours one by one.
 */
@Injectable()
export class BasketCaptureService {
  constructor(
    @Inject(BASKET_STORE) private readonly store: BasketStore,
    private readonly settings: RecommendationsSettings,
  ) {}

  async capture(events: PaidOrderEvent[]): Promise<SinkCounts> {
    const orders = events.map((e) => {
      const parsed = parsePaidOrder(e.payload);
      if (!parsed.ok)
        throw new PermanentError(
          `order.paid is not usable: ${parsed.paths.join(', ') || 'payload'}`,
        );
      return parsed.order;
    });

    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    const rows = new Map<string, BasketRow>();
    for (const order of orders) {
      const basket = toBasket(
        order.lines.map((l) => l.productId),
        { min: this.settings.basketMin, max: this.settings.basketMax },
      );
      if (!basket.ok) {
        recommendationsBasketSkipped.add(1, { reason: basket.reason });
        counts.applied++;
        continue;
      }
      const row = this.toRow(order, basket.products);
      const queued = rows.get(row.orderId);
      // within a batch the highest version wins; on a tie the first delivery is kept
      if (!queued || row.orderVersion > queued.orderVersion) {
        if (queued) this.count(counts, 'stale');
        rows.set(row.orderId, row);
      } else
        this.count(
          counts,
          row.orderVersion === queued.orderVersion ? 'duplicate' : 'stale',
        );
    }

    const stored = await this.store.storedVersions([...rows.keys()]);
    const fresh: BasketRow[] = [];
    for (const row of rows.values()) {
      const known = stored.get(row.orderId);
      if (known === undefined || row.orderVersion > known) fresh.push(row);
      else
        this.count(counts, row.orderVersion === known ? 'duplicate' : 'stale');
    }
    if (fresh.length > 0) await this.store.insert(fresh);
    counts.applied += fresh.length;
    recommendationsBaskets.add(fresh.length, { outcome: 'stored' });
    return counts;
  }

  private toRow(order: PaidOrder, products: string[]): BasketRow {
    return {
      orderId: order.orderId,
      buyerId: order.userId,
      products,
      paidAt: new Date(order.paidAt),
      orderVersion: order.orderVersion,
    };
  }

  private count(counts: SinkCounts, outcome: 'duplicate' | 'stale'): void {
    counts[outcome]++;
    recommendationsBaskets.add(1, { outcome });
  }
}
