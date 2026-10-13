import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { PickupPointChanged } from '../application/events/pickup-events';
import { PickupProjectionService } from '../application/pickup-projection.service';

/**
 * `pickup.point_changed` → availability index (S19 FR-030): a name, address or `active` change reaches every offer of
 * the point. The documents are rebuilt from the point row as it is now, so a lower `pointVersion` arriving late
 * changes nothing and a stock event for an inactive point cannot make its offers visible.
 */
@Injectable()
export class PickupPointProjector implements Projector {
  readonly name: string = 'pickup-index-point';
  readonly topics: string[] = [PickupPointChanged.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [{ event: PickupPointChanged }];
  readonly coalesce = true;
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly projection: PickupProjectionService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const changes = events
      .map((e) => PickupPointChanged.match(e))
      .filter((e): e is NonNullable<typeof e> => !!e);
    const counts = await this.projection.applyPoints(
      changes.map((c) => c.payload.pickupPointId),
    );
    this.projection.recordLag(changes.map((c) => c.occurredAt));
    return counts;
  }
}
