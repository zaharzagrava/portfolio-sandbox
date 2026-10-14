import { Injectable } from '@nestjs/common';
import { ShopDeleted, ShopStatusChanged } from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { ApiRequestLogged } from '../application/events/api-events';
import { ShopLifecycleHandler } from '../application/shop-lifecycle.handler';
import { UsageMeteringHandler } from '../application/usage-metering.handler';
import { ShopStatusGate } from '../application/shop-status.gate';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `api.request_logged` → billable minutes (FR-058, AS-64, group `public-api-usage-metering`). The handler records the event
 * id in the inbox inside the transaction that adds the quantity, so it is idempotent on its own and a restart changes
 * nothing; an invalid payload is dead-lettered without effect.
 */
@Injectable()
export class PublicApiUsageMeteringConsumer implements Projector {
  readonly name = 'public-api-usage-metering';
  readonly topics = [ApiRequestLogged.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly handles: HandledEvent[] = [{ event: ApiRequestLogged }];
  readonly attempts = 3;

  constructor(private readonly metering: UsageMeteringHandler) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const envelope of events) {
      let matched;
      try {
        matched = ApiRequestLogged.match(envelope);
      } catch {
        throw new PermanentError('invalid api.request_logged payload');
      }
      if (!matched) continue;
      const p = matched.payload;
      await this.metering.record({
        eventId: matched.eventId,
        requestId: p.requestId,
        shopId: p.shopId,
        livemode: p.livemode,
        status: p.status,
        cost: p.cost,
        at: new Date(matched.occurredAt),
      });
    }
  }
}

/**
 * `tenancy.events` (key `shopId`) for the public API (FR-013, group `public-api-shop-lifecycle`):
 *  - `tenancy.shop_deleted`: the shop's keys are revoked once;
 *  - `tenancy.shop_status_changed`: the shop's cached status is dropped so the next call sees the new one at once.
 * Both are idempotent by nature (the conditional revoke finds nothing the second time; dropping an entry twice is the
 * same). A payload that is not valid is dead-lettered and nothing changes (VII.4).
 */
@Injectable()
export class PublicApiShopLifecycleConsumer implements Projector {
  readonly name = 'public-api-shop-lifecycle';
  readonly topics = [ShopDeleted.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly handles: HandledEvent[] = [
    { event: ShopDeleted },
    { event: ShopStatusChanged },
  ];
  readonly attempts = 3;

  constructor(
    private readonly handler: ShopLifecycleHandler,
    private readonly status: ShopStatusGate,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const envelope of events) {
      if (envelope.type === ShopDeleted.type) {
        await this.handler.shopDeleted(this.shopIdOf(ShopDeleted, envelope));
      } else if (envelope.type === ShopStatusChanged.type) {
        await this.status.invalidate(
          this.shopIdOf(ShopStatusChanged, envelope),
        );
      }
    }
  }

  /** The shop id of a valid payload; the id reaches SQL and cache keys, so anything else is poison. */
  private shopIdOf(
    definition: typeof ShopDeleted | typeof ShopStatusChanged,
    envelope: EventEnvelope,
  ): string {
    let shopId: string | undefined;
    try {
      shopId = definition.match(envelope)?.payload.shopId;
    } catch {
      shopId = undefined;
    }
    if (!shopId || !UUID.test(shopId))
      throw new PermanentError(`invalid ${definition.type} payload`);
    return shopId;
  }
}
