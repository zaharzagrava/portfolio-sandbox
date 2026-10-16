import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { ShopDeleted } from '@app/domains/tenancy';
import { RetentionService } from '../application/retention.service';

export const SHOP_DELETED_CONSUMER = 'seller-onboarding-shop-deleted';

/**
 * `tenancy.shop_deleted` (S04 FR-050, FR-064): the shop's raw KYC files are deleted at once, its open review tasks are
 * cancelled and the erasure of its records is scheduled. The framework validates the payload against tenancy's contract
 * and dead-letters an event that does not parse, so an invalid event has no effect. `natural` idempotency, not `inbox`:
 * every step is idempotent (purged files are skipped, cancelled tasks stay cancelled, the erase job has a unique key),
 * and the storage deletes must not run inside the inbox transaction (no network call in a transaction, FR-061).
 */
@Injectable()
export class OnboardingShopDeletedConsumer implements Projector {
  readonly name: string = SHOP_DELETED_CONSUMER;
  readonly topics: string[] = [ShopDeleted.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly attempts = 5;
  readonly handles: HandledEvent[] = [{ event: ShopDeleted }];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly retention: RetentionService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const shopIds = events.map((event) => {
      const parsed = z
        .string()
        .uuid()
        .safeParse((event.payload as { shopId?: unknown }).shopId);
      if (!parsed.success)
        throw new PermanentError(`invalid ${event.type} payload`);
      return parsed.data;
    });
    for (const shopId of new Set(shopIds))
      await this.retention.shopDeleted(shopId);
  }
}
