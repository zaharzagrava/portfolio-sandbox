import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { VerificationService } from '../../application/verification.service';
import {
  OnboardingSubmittedSeen,
  ShopRejectedSeen,
  ShopVerifiedSeen,
} from '../../domain/events';
import type { VerificationEvent } from '../../domain/verification-status';

type Consumed =
  | typeof OnboardingSubmittedSeen
  | typeof ShopVerifiedSeen
  | typeof ShopRejectedSeen;

const KINDS: Array<[Consumed, VerificationEvent]> = [
  [OnboardingSubmittedSeen, 'submitted'],
  [ShopVerifiedSeen, 'verified'],
  [ShopRejectedSeen, 'rejected'],
];

/**
 * `shop.onboarding_submitted`, `shop.verified`, `shop.rejected` (seller onboarding, S04) → the verification machine
 * (AS-72). The framework records `(consumer, eventId)` in the effect's transaction (`inbox`), so a duplicate delivery
 * is one change and one event. Only `shopId` is read; an invalid payload is a permanent failure (dead letter).
 */
@Injectable()
export class VerificationProjector implements Projector {
  readonly name = 'tenancy-verification';
  readonly topics = [OnboardingSubmittedSeen.topic];
  readonly idempotency = 'inbox' as const;
  readonly handles = KINDS.map(([event]) => ({ event }));

  constructor(private readonly verification: VerificationService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const raw of events) {
      for (const [definition, kind] of KINDS) {
        let event: ReturnType<typeof definition.match>;
        try {
          event = definition.match(raw);
        } catch (error) {
          throw new PermanentError(
            `invalid ${raw.type} payload: ${(error as Error).message}`,
          );
        }
        if (!event) continue;
        const outcome = await this.verification.apply(
          event.payload.shopId,
          kind,
        );
        if (outcome === 'changed') counts.applied++;
        else counts.stale++;
      }
    }
    return counts;
  }
}
