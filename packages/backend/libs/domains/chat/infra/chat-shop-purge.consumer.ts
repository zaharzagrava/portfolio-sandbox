import { Injectable } from '@nestjs/common';
import { ShopDeleted } from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { ChatShopPurgeService } from '../application/chat-shop-purge.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `tenancy.shop_deleted` (topic `tenancy.events`, key `shopId`): the shop's chats go (S24 FR-043). Idempotency is
 * `natural`: the second delivery finds nothing. The id reaches SQL, so a payload that is not a UUID is poison: it is
 * dead-lettered and nothing is deleted (VII.4). `tenancy.shop_offboarding_started` is not consumed: chat exports nothing.
 */
@Injectable()
export class ChatShopPurgeConsumer implements Projector {
  readonly name = 'chat-shop-purge';
  readonly topics = [ShopDeleted.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly handles: HandledEvent[] = [{ event: ShopDeleted }];
  readonly attempts = 3;

  constructor(private readonly purge: ChatShopPurgeService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const envelope of events) {
      if (envelope.type !== ShopDeleted.type) continue;
      let shopId: string | undefined;
      try {
        shopId = ShopDeleted.match(envelope)?.payload.shopId;
      } catch {
        shopId = undefined;
      }
      if (!shopId || !UUID.test(shopId))
        throw new PermanentError('invalid tenancy.shop_deleted payload');
      await this.purge.purgeShop(shopId);
    }
  }
}
