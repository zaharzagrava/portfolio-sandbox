import { Injectable } from '@nestjs/common';
import {
  ShopDeleted,
  ShopStatusChanged,
  ShopUpdated,
} from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { WidgetShopLifecycleHandler } from '../application/widget-shop-lifecycle.handler';

type Definition =
  typeof ShopUpdated | typeof ShopStatusChanged | typeof ShopDeleted;

/**
 * The payload of a valid event, or `PermanentError`: an invalid message is dead-lettered and nothing changes (VII.4,
 * FR-035). The shop id reaches SQL and cache keys, so anything that is not a UUID is poison too.
 */
function payloadOf<D extends Definition>(
  definition: D,
  envelope: EventEnvelope,
): NonNullable<ReturnType<D['match']>>['payload'] {
  let matched;
  try {
    matched = definition.match(envelope);
  } catch {
    matched = undefined;
  }
  const payload = matched?.payload as { shopId?: unknown } | undefined;
  if (
    !payload ||
    typeof payload.shopId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      payload.shopId,
    )
  )
    throw new PermanentError(`invalid ${definition.type} payload`);
  return payload as never;
}

/** `tenancy.shop_updated` → the shop name of the copy on every site of the shop (group `widget-shop-updated`). */
@Injectable()
export class WidgetShopUpdatedConsumer implements Projector {
  readonly name = 'widget-shop-updated';
  readonly topics = [ShopUpdated.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly handles: HandledEvent[] = [{ event: ShopUpdated }];
  readonly attempts = 3;

  constructor(private readonly handler: WidgetShopLifecycleHandler) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const envelope of events) {
      if (envelope.type !== ShopUpdated.type) continue;
      const p = payloadOf(ShopUpdated, envelope);
      await this.handler.shopUpdated({
        shopId: p.shopId,
        name: p.name,
        shopVersion: p.shopVersion,
      });
    }
  }
}

/** `tenancy.shop_status_changed` → the shop status of the copy (group `widget-shop-status`). */
@Injectable()
export class WidgetShopStatusConsumer implements Projector {
  readonly name = 'widget-shop-status';
  readonly topics = [ShopStatusChanged.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly handles: HandledEvent[] = [{ event: ShopStatusChanged }];
  readonly attempts = 3;

  constructor(private readonly handler: WidgetShopLifecycleHandler) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const envelope of events) {
      if (envelope.type !== ShopStatusChanged.type) continue;
      const p = payloadOf(ShopStatusChanged, envelope);
      await this.handler.statusChanged({
        shopId: p.shopId,
        to: p.to,
        shopVersion: p.shopVersion,
      });
    }
  }
}

/** `tenancy.shop_deleted` → the shop's sites and their history are removed (group `widget-shop-deleted`). */
@Injectable()
export class WidgetShopDeletedConsumer implements Projector {
  readonly name = 'widget-shop-deleted';
  readonly topics = [ShopDeleted.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly handles: HandledEvent[] = [{ event: ShopDeleted }];
  readonly attempts = 3;

  constructor(private readonly handler: WidgetShopLifecycleHandler) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const envelope of events) {
      if (envelope.type !== ShopDeleted.type) continue;
      await this.handler.shopDeleted(payloadOf(ShopDeleted, envelope).shopId);
    }
  }
}
