import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  ShopDeleted,
  ShopOffboardingCancelled,
  ShopOffboardingStarted,
} from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { InboxService } from '@app/infrastructure/inbox/inbox.service';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { TenancyLifecycleService } from '../application/tenancy-lifecycle.service';

const shopIdSchema = z.string().uuid();

/** Consumer group and inbox name of the one consumer that carries the three lifecycle events. */
export const TENANCY_CONSUMER = 'billing-tenancy-lifecycle';

/**
 * Reacts to a shop's lifecycle (S17 FR-048, FR-049; contracts/events.md "Consumed"). The framework hands over
 * envelopes already validated against the tenancy contracts (a missing or non-UUID `shopId` is dead-lettered before
 * it gets here). Each event is recorded in the inbox in the SAME transaction as its effect, so a duplicate changes
 * nothing and a rolled-back effect leaves no record.
 */
@Injectable()
export class TenancyLifecycleConsumer implements Projector {
  private readonly logger = new Logger(TenancyLifecycleConsumer.name);
  readonly name = TENANCY_CONSUMER;
  readonly topics = [ShopOffboardingStarted.topic];
  readonly idempotency: IdempotencyMechanism = 'inbox';
  readonly handles: HandledEvent[] = [
    { event: ShopOffboardingStarted },
    { event: ShopOffboardingCancelled },
    { event: ShopDeleted },
  ];

  constructor(
    private readonly lifecycle: TenancyLifecycleService,
    private readonly inbox: InboxService,
    private readonly runner: TransactionRunner,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const envelope of events) {
      // The framework refuses an envelope without an id before it gets here; this keeps the inbox key honest anyway.
      if (typeof envelope.eventId !== 'string' || envelope.eventId === '')
        throw new PermanentError('missing_event_id');
      const effect = await this.runner.run(async () => {
        if (!(await this.inbox.recordOnce(this.name, envelope.eventId)))
          return 'duplicate' as const;
        return this.apply(envelope);
      });
      if (effect === 'duplicate') counts.duplicate++;
      else if (effect === 'ignored') counts.stale++;
      else counts.applied++;
    }
    return counts;
  }

  private apply(envelope: EventEnvelope) {
    // The tenancy contracts accept any string id; billing keys its rows by UUID, so a malformed one is refused here.
    const parsed = shopIdSchema.safeParse(
      (envelope.payload as { shopId?: unknown }).shopId,
    );
    if (!parsed.success) throw new PermanentError('invalid_payload');
    const shopId = parsed.data;
    const occurredAt = new Date(envelope.occurredAt);
    switch (envelope.type) {
      case ShopOffboardingStarted.type:
        return this.lifecycle.offboardingStarted(
          shopId,
          envelope.eventId,
          occurredAt,
        );
      case ShopOffboardingCancelled.type:
        return this.lifecycle.offboardingCancelled(
          shopId,
          envelope.eventId,
          occurredAt,
        );
      case ShopDeleted.type:
        return this.lifecycle.deleted(shopId, envelope.eventId);
      default:
        this.logger.warn(`ignored unexpected event type ${envelope.type}`);
        return Promise.resolve('ignored' as const);
    }
  }
}

export const billingProjectors = [TenancyLifecycleConsumer];
