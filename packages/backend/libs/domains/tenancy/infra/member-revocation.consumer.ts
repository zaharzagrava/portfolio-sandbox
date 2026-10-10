import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  PermanentError,
  TransientError,
} from '@app/infrastructure/projections/errors';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import {
  RealtimeSubscriptions,
  RealtimeUnavailableError,
} from '@app/infrastructure/realtime';
import { MemberRemoved } from '../domain/events';

/**
 * `tenancy.member_removed` → ends the removed member's open `shop:<id>:*` streams (S03 follow-up left for S51, FR-039).
 * Every reason (`removed`, `left`, `shop_deleted`) revokes: the user lost the right either way. It closes all suffixes of
 * the shop topic (`live`, `assets`, and any later one) for that user only.
 *
 * Idempotent by nature (constitution IV.5, `natural`): revoking twice ends nothing more, so no inbox or version guard is
 * needed. Revocation is not a ban: the topic's rule (the database membership) still decides a reconnect. A store fault
 * is transient and retried; the connection lifetime bounds the worst case if a notice is never delivered.
 */
@Injectable()
export class MemberRevocationConsumer implements Projector {
  readonly name = 'tenancy-member-revocation';
  readonly topics = [MemberRemoved.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: MemberRemoved }];

  constructor(private readonly subscriptions: RealtimeSubscriptions) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const raw of events) {
      let event: ReturnType<typeof MemberRemoved.match>;
      try {
        event = MemberRemoved.match(raw);
      } catch (error) {
        throw new PermanentError(
          `invalid ${raw.type} payload: ${(error as Error).message}`,
        );
      }
      if (!event) continue;
      const { shopId, userId } = event.payload;
      try {
        await this.subscriptions.revoke({ userId, prefix: 'shop', id: shopId });
      } catch (error) {
        if (error instanceof RealtimeUnavailableError)
          throw new TransientError(error.message);
        throw error;
      }
      counts.applied++;
    }
    return counts;
  }
}
