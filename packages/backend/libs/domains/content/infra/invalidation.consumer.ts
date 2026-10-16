import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, type Clock } from '@app/common/core/clock';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { InboxService } from '@app/infrastructure/inbox';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { CacheInvalidationService } from '../application/cache-invalidation.service';
import {
  StoryArchived,
  StoryPublished,
} from '../application/events/story-events';
import { logOutcome } from '../application/story-log';
import {
  PURGE_LAG_ALERT_SECONDS,
  storyMetrics,
} from '../application/story-metrics';
import { STORY_DEFAULTS } from '../domain/limits';
import { matchEvent } from './consumer-support';

export const INVALIDATION_CONSUMER = 'content-cache-invalidation';

interface Change {
  eventId: string;
  occurredAt: string;
  storyId: string;
  shopId: string;
  shopSlug: string;
  slug: string;
}

/**
 * `stories.events` → every cache layer by tag (S27 FR-031 to FR-033, AS-51 to AS-57): per event the origin entry is
 * cleared first, then the CDN is purged by `story:<id>` and `shop:<shopId>` and the front end is told, distinct tags
 * batched in calls of at most 30. The event is recorded as processed only after both targets succeeded, so a duplicate
 * delivery calls nothing and a failed try is repeated whole (purging twice is harmless). Content is never built from
 * the payload: after the purge the next read comes from the durable store. The framework's attempt budget (8) ends in
 * the dead letter; a permanent CDN refusal and an invalid payload are dead letters at once.
 */
@Injectable()
export class StoryInvalidationConsumer implements Projector {
  readonly name: string = INVALIDATION_CONSUMER;
  readonly topics: string[] = [StoryPublished.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly attempts: number = STORY_DEFAULTS.invalidationAttempts;
  readonly handles: HandledEvent[] = [
    { event: StoryPublished },
    { event: StoryArchived },
  ];
  readonly aggregateIdSchema = z.string().uuid();
  private readonly logger = new Logger('StoryInvalidationConsumer');

  constructor(
    private readonly invalidation: CacheInvalidationService,
    private readonly inbox: InboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const changes = events.flatMap((event) => this.change(event));
    const claimed: Change[] = [];
    for (const change of changes) {
      const claim = await this.inbox.claim(this.name, change.eventId);
      if (claim.outcome === 'CLAIMED') claimed.push(change);
    }
    if (claimed.length === 0) return;
    try {
      for (const change of claimed)
        await this.invalidation.clearOrigin(change.shopSlug, change.slug);
      await this.invalidation.purge(
        this.invalidation.batches(
          claimed.map((c) => ({
            eventId: c.eventId,
            tags: [`story:${c.storyId}`, `shop:${c.shopId}`],
          })),
        ),
      );
    } catch (error) {
      for (const change of claimed)
        await this.inbox.markStatus(this.name, change.eventId, 'FAILED');
      throw error;
    }
    for (const change of claimed) {
      await this.inbox.markStatus(this.name, change.eventId, 'PROCESSED');
      this.observeLag(change);
    }
  }

  private change(event: EventEnvelope): Change[] {
    const invalid = (type: string) => this.invalid(type);
    const matched =
      matchEvent(StoryPublished, event, invalid) ??
      matchEvent(StoryArchived, event, invalid);
    if (!matched) {
      if (
        ([StoryPublished.type, StoryArchived.type] as string[]).includes(
          event.type,
        )
      )
        throw this.invalid(event.type);
      return []; // schedule failures and other types are not this consumer's
    }
    const p = matched.payload;
    return [
      {
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        storyId: p.storyId,
        shopId: p.shopId,
        shopSlug: p.shopSlug,
        slug: p.slug,
      },
    ];
  }

  private observeLag(change: Change): void {
    const seconds = Math.max(
      0,
      (this.clock.nowMs() - Date.parse(change.occurredAt)) / 1_000,
    );
    storyMetrics.cachePurgeLag.record(seconds);
    logOutcome(this.logger, 'story.invalidation', {
      outcome: 'purged',
      storyId: change.storyId,
      shopId: change.shopId,
      lagSeconds: Math.round(seconds),
    });
    if (seconds > PURGE_LAG_ALERT_SECONDS)
      this.logger.error(
        `alert: invalidation completed ${Math.round(seconds)} s after the event`,
      );
  }

  private invalid(type: string): PermanentError {
    storyMetrics.deadLettered.add(1, { reason: 'invalid_payload' });
    this.logger.error(`alert: ${type} dead-lettered (invalid payload)`);
    return new PermanentError(`invalid ${type} payload`);
  }
}
