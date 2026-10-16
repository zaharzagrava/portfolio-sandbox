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
import { OrderExportMaintenanceService } from '../application/order-export-maintenance.service';

export const EXPORT_OFFBOARDING_CONSUMER = 'order-export-shop-offboarding';
export const EXPORT_SHOP_DELETED_CONSUMER = 'order-export-shop-deleted';

const shopId = z.string().uuid();

/**
 * The shop an event is about. An event whose payload does not parse, or whose version this consumer does not know, can
 * never be applied: dead letter, no effect.
 */
function shopOf(
  envelope: EventEnvelope,
  schema: z.ZodType<{ shopId: string }>,
): string {
  const parsed = schema.safeParse(envelope.payload);
  if (
    envelope.version !== 1 ||
    !parsed.success ||
    !shopId.safeParse(parsed.data.shopId).success
  )
    throw new PermanentError(`invalid ${envelope.type} event`);
  return parsed.data.shopId;
}

/**
 * `tenancy.shop_offboarding_started` cancels the shop's queued and running exports (reason `shop_offboarding`);
 * `tenancy.shop_offboarding_cancelled` is ignored (a cancelled export is not brought back). `inbox`: a duplicate
 * delivery is recognised before it is applied; the conditional cancel makes a repeat harmless in any case.
 */
@Injectable()
export class OrderExportOffboardingConsumer implements Projector {
  readonly name: string = EXPORT_OFFBOARDING_CONSUMER;
  readonly topics: string[] = [ShopOffboardingStarted.topic];
  readonly idempotency: IdempotencyMechanism = 'inbox';
  readonly attempts = 5;
  readonly handles: HandledEvent[] = [
    { event: ShopOffboardingStarted },
    { event: ShopOffboardingCancelled },
  ];
  readonly aggregateIdSchema = shopId;

  constructor(private readonly maintenance: OrderExportMaintenanceService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    // Validate the whole batch first: an invalid event is dead-lettered before anything is changed.
    const work = events.map((envelope) => {
      if (envelope.type === ShopOffboardingStarted.type)
        return {
          start: true,
          shopId: shopOf(envelope, ShopOffboardingStarted.schema),
        };
      if (envelope.type === ShopOffboardingCancelled.type) {
        shopOf(envelope, ShopOffboardingCancelled.schema);
        return { start: false, shopId: '' };
      }
      throw new PermanentError(`unexpected ${envelope.type}`);
    });
    for (const item of work)
      if (item.start)
        await this.maintenance.cancelForShop(item.shopId, 'shop_offboarding');
  }
}

/**
 * `tenancy.shop_deleted` removes the shop's exports: active ones are cancelled, files deleted, rows and history removed
 * in bounded chunks (AS-54). `natural`: the removal is idempotent and resumable (a redelivery after a crash continues, a
 * second delivery finds nothing), and an inbox transaction around it would hold every chunk in one transaction.
 */
@Injectable()
export class OrderExportShopDeletedConsumer implements Projector {
  readonly name: string = EXPORT_SHOP_DELETED_CONSUMER;
  readonly topics: string[] = [ShopDeleted.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly attempts = 5;
  readonly handles: HandledEvent[] = [{ event: ShopDeleted }];
  readonly aggregateIdSchema = shopId;

  constructor(private readonly maintenance: OrderExportMaintenanceService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const shops = [
      ...new Set(
        events.map((envelope) => shopOf(envelope, ShopDeleted.schema)),
      ),
    ];
    for (const id of shops) await this.maintenance.deleteShop(id);
  }
}
