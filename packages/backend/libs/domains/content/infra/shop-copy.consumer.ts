import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ShopCreated,
  ShopDeleted,
  ShopStatusChanged,
  ShopUpdated,
} from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { InboxService } from '@app/infrastructure/inbox';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { ShopCopyService } from '../application/shop-copy.service';
import { storyMetrics } from '../application/story-metrics';
import { matchEvent } from './consumer-support';

export const SHOP_COPY_CONSUMER = 'content-shop-copy';

const uuid = z.string().uuid();

/**
 * Keeps `StoryShop` from the tenancy events (R3, S27 FR-062): created and updated give the slug, a status change gives
 * the status; all carry the shop's version, and the copy only moves forward. `natural` idempotency for the copy itself
 * (the version guard), plus the inbox for a status change because its side effects (clearing caches) must run once
 * per event and be repeated when a try failed half-way. An invalid payload is a dead letter, never a write.
 */
@Injectable()
export class StoryShopCopyConsumer implements Projector {
  readonly name: string = SHOP_COPY_CONSUMER;
  readonly topics: string[] = [ShopCreated.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly attempts = 5;
  readonly handles: HandledEvent[] = [
    { event: ShopCreated },
    { event: ShopUpdated },
    { event: ShopStatusChanged },
    { event: ShopDeleted },
  ];
  readonly aggregateIdSchema = uuid;

  constructor(
    private readonly shops: ShopCopyService,
    private readonly inbox: InboxService,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const event of events) await this.handle(event);
  }

  private async handle(event: EventEnvelope): Promise<void> {
    const invalid = (type: string) => this.invalid(type);
    const created = matchEvent(ShopCreated, event, invalid);
    if (created) {
      this.assertShop(created.payload.shopId, event.type);
      return this.shops.onIdentity(created.payload);
    }
    const updated = matchEvent(ShopUpdated, event, invalid);
    if (updated) {
      this.assertShop(updated.payload.shopId, event.type);
      return this.shops.onIdentity(updated.payload);
    }
    const status = matchEvent(ShopStatusChanged, event, invalid);
    if (status) {
      this.assertShop(status.payload.shopId, event.type);
      return this.statusChanged(event, status.payload);
    }
    const deleted = matchEvent(ShopDeleted, event, invalid);
    if (deleted) {
      this.assertShop(deleted.payload.shopId, event.type);
      return this.shops.onDeleted(deleted.payload.shopId, event.eventId);
    }
    // a type of the topic this consumer does not use is skipped; one it uses at a version it does not know is not
    if (
      (
        [
          ShopCreated.type,
          ShopUpdated.type,
          ShopStatusChanged.type,
          ShopDeleted.type,
        ] as string[]
      ).includes(event.type)
    )
      throw this.invalid(event.type);
  }

  private async statusChanged(
    event: EventEnvelope,
    payload: {
      shopId: string;
      from: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
      to: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
      shopVersion: number;
    },
  ): Promise<void> {
    // the copy always takes the event (a replay rebuilds an empty copy from events seen before); the inbox only
    // decides whether the caches are cleared: once per event, and again when an earlier try did not finish
    const claim = await this.inbox.claim(this.name, event.eventId);
    try {
      const applied = await this.shops.applyStatus(payload);
      if (claim.outcome !== 'CLAIMED') return;
      if (applied || claim.attempts > 1)
        await this.shops.clearForStatusChange({
          ...payload,
          eventId: event.eventId,
        });
      await this.inbox.markStatus(this.name, event.eventId, 'PROCESSED');
    } catch (error) {
      if (claim.outcome === 'CLAIMED')
        await this.inbox.markStatus(this.name, event.eventId, 'FAILED');
      throw error;
    }
  }

  private assertShop(shopId: string, type: string): void {
    if (!uuid.safeParse(shopId).success) throw this.invalid(type);
  }

  private invalid(type: string): PermanentError {
    storyMetrics.shopCopy.add(1, { result: 'dead_lettered' });
    return new PermanentError(`invalid ${type} payload`);
  }
}
