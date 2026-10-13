import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { PickupStockChanged } from '../application/events/pickup-events';
import { PickupProjectionService } from '../application/pickup-projection.service';

/** `<pickupPointId>:<productId>`, two UUIDs. */
const STOCK_AGGREGATE_ID = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );

/**
 * `pickup.stock_changed` → availability index (S19 FR-030). Every event carries the absolute stock of one pair, so a
 * burst is reduced to its newest event per pair by the framework (`coalesce`); the handler rebuilds the document from
 * the stock row as it is now, so a late older event cannot bring back stock that has gone.
 */
@Injectable()
export class PickupStockProjector implements Projector {
  readonly name: string = 'pickup-index-stock';
  readonly topics: string[] = [PickupStockChanged.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [{ event: PickupStockChanged }];
  readonly coalesce = true;
  readonly aggregateIdSchema = STOCK_AGGREGATE_ID;

  constructor(private readonly projection: PickupProjectionService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const changes = events
      .map((e) => PickupStockChanged.match(e))
      .filter((e): e is NonNullable<typeof e> => !!e);
    const counts = await this.projection.applyStock(
      changes.map((c) => ({
        pickupPointId: c.payload.pickupPointId,
        productId: c.payload.productId,
      })),
    );
    this.projection.recordLag(changes.map((c) => c.occurredAt));
    return counts;
  }
}
