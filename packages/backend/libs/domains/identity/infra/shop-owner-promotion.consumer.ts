import { Inject, Injectable } from '@nestjs/common';
import { ShopCreated } from '@app/domains/tenancy/domain/events';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { USER_REPOSITORY, type UserRepository } from '../domain/ports';

/**
 * `tenancy.shop_created` v1 → the owner becomes a `SELLER` (S03 follow-up left for S01). One conditional update
 * (`WHERE role = 'USER'`), so a redelivery, a `SELLER`, `ADMIN` or `MODERATOR` owner, an unknown user and a sandbox shop
 * (`ownerId` null) change nothing: idempotent by nature (`natural`). The new role reaches tokens at the next refresh.
 */
@Injectable()
export class ShopOwnerPromotionConsumer implements Projector {
  readonly name = 'identity-shop-owner-promotion';
  readonly topics = [ShopCreated.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: ShopCreated }];

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const raw of events) {
      let event: ReturnType<typeof ShopCreated.match>;
      try {
        event = ShopCreated.match(raw);
      } catch (error) {
        throw new PermanentError(
          `invalid ${raw.type} payload: ${(error as Error).message}`,
        );
      }
      if (!event) continue;
      const { ownerId } = event.payload;
      if (ownerId && (await this.users.promoteToSeller(ownerId)))
        counts.applied++;
      else counts.duplicate++;
    }
    return counts;
  }
}
