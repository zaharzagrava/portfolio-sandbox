import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import {
  ShopDeleted,
  ShopOffboardingCancelled,
  ShopOffboardingStarted,
} from '@app/domains/tenancy';
import { LifecycleService } from '../application/lifecycle.service';

export const OFFBOARDING_CONSUMER = 'catalog-sync-shop-offboarding';
export const SHOP_DELETED_CONSUMER = 'catalog-sync-shop-deleted';

const shopId = z.string().uuid();

/** The shop an event is about; an event whose payload does not parse can never be applied (dead letter). */
function shopOf(
  envelope: EventEnvelope,
  schema: z.ZodType<{ shopId: string }>,
): string {
  const parsed = schema.safeParse(envelope.payload);
  if (!parsed.success || !shopId.safeParse(parsed.data.shopId).success)
    throw new PermanentError(`invalid ${envelope.type} payload`);
  return parsed.data.shopId;
}

/**
 * `tenancy.shop_offboarding_started` pauses the shop's `ACTIVE` integrations, `tenancy.shop_offboarding_cancelled`
 * resumes the ones paused for it (AS-74). `inbox`: the `(consumer, eventId)` record is written in the transaction of
 * the effect, so a duplicate delivery is recognised before it is applied, and a rolled-back effect leaves no record.
 * The status machine's conditional updates make a repeat harmless in any case.
 */
@Injectable()
export class TenancyOffboardingConsumer implements Projector {
  readonly name: string = OFFBOARDING_CONSUMER;
  readonly topics: string[] = [ShopOffboardingStarted.topic];
  readonly idempotency: IdempotencyMechanism = 'inbox';
  readonly attempts = 5;
  readonly handles: HandledEvent[] = [
    { event: ShopOffboardingStarted },
    { event: ShopOffboardingCancelled },
  ];
  readonly aggregateIdSchema = shopId;

  constructor(private readonly lifecycle: LifecycleService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    // Validate the whole batch first: an invalid event is dead-lettered before anything is changed.
    const work = events.map((envelope) => {
      if (envelope.type === ShopOffboardingStarted.type)
        return {
          type: 'started' as const,
          shopId: shopOf(envelope, ShopOffboardingStarted.schema),
        };
      if (envelope.type === ShopOffboardingCancelled.type)
        return {
          type: 'cancelled' as const,
          shopId: shopOf(envelope, ShopOffboardingCancelled.schema),
        };
      throw new PermanentError(`unexpected ${envelope.type}`);
    });
    for (const item of work)
      if (item.type === 'started')
        await this.lifecycle.offboardingStarted(item.shopId);
      else await this.lifecycle.offboardingCancelled(item.shopId);
  }
}

/**
 * `tenancy.shop_deleted` purges everything of the shop in batches of at most 1,000 rows, each its own transaction
 * (AS-75). `natural`: the purge is idempotent and resumable (a redelivery after a crash continues where it stopped, a
 * second delivery deletes nothing), and an inbox transaction around it would hold every batch in one transaction.
 */
@Injectable()
export class TenancyShopDeletedConsumer implements Projector {
  readonly name: string = SHOP_DELETED_CONSUMER;
  readonly topics: string[] = [ShopDeleted.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly attempts = 5;
  readonly handles: HandledEvent[] = [{ event: ShopDeleted }];
  readonly aggregateIdSchema = shopId;

  constructor(private readonly lifecycle: LifecycleService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const shops = [
      ...new Set(
        events.map((envelope) => shopOf(envelope, ShopDeleted.schema)),
      ),
    ];
    for (const id of shops) await this.lifecycle.purgeShop(id);
  }
}
