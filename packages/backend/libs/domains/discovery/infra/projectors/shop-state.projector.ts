import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import {
  ShopDeleted,
  ShopOffboardingCancelled,
  ShopOffboardingStarted,
  ShopPlanChanged,
  ShopStatusChanged,
} from '@app/domains/tenancy';
import { ShopStateProjectionService } from '../../application/projection/shop-state-projection.service';

/** Group `search-shop-state`: shop status, plan and offboarding into the copy and the shop stamp (S32 FR-022). */
@Injectable()
export class ShopStateProjector implements Projector {
  readonly name = 'search-shop-state';
  readonly topics = [ShopStatusChanged.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [
    { event: ShopStatusChanged },
    { event: ShopPlanChanged },
    { event: ShopOffboardingStarted },
    { event: ShopOffboardingCancelled },
    { event: ShopDeleted },
  ];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly projection: ShopStateProjectionService) {}

  project(events: EventEnvelope[]): Promise<SinkCounts> {
    return this.projection.project(events);
  }
}
