import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { registeredEventDefinitions } from '@app/infrastructure/events/define-event';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { EventPublisher } from '@app/infrastructure/events/event-publisher';
import { discussionRelayCounter } from '../domain/discussions-metrics';
import { dayOf, hourOf } from '../domain/months';
import {
  EVENT_STORE,
  type EventStore,
  type PendingEvent,
} from '../domain/ports';

const SHARDS_PER_HOUR = 8;
const BATCH = 200;
const HOUR_MS = 3_600_000;

/**
 * Relays recorded events to `discussion.events` at least once (S25 G1, R-3). An event is deleted from the work queue
 * only after the bus accepted it; the `eventId` was fixed at write time, so a repeated delivery is the same event.
 * A recorded event that is not a valid envelope of a known definition goes to `dead_events` and has no other effect.
 */
@Injectable()
export class EventRelayService {
  private readonly logger = new Logger(EventRelayService.name);

  constructor(
    @Inject(EVENT_STORE) private readonly events: EventStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly publisher: EventPublisher,
  ) {}

  /** Scans the work-queue shards of the last `hours` hours (48 covers everything the queue keeps). */
  async relay(
    hours = 3,
  ): Promise<{ published: number; failed: number; dead: number }> {
    const shards: string[] = [];
    for (let h = 0; h <= hours; h++) {
      const hour = hourOf(new Date(this.clock.nowMs() - h * HOUR_MS));
      for (let s = 0; s < SHARDS_PER_HOUR; s++)
        shards.push(String(hour * SHARDS_PER_HOUR + s));
    }
    const result = { published: 0, failed: 0, dead: 0 };
    const pending = await this.events.pending(shards, BATCH);
    for (const event of pending) {
      const verdict = this.parse(event);
      if (typeof verdict === 'string') {
        await this.events.deadLetter(event, verdict, dayOf(this.clock.now()));
        discussionRelayCounter.add(1, { result: 'dead' });
        result.dead++;
        continue;
      }
      try {
        await this.publisher.publish(verdict as EventEnvelope);
        await this.events.delivered(event);
        discussionRelayCounter.add(1, { result: 'published' });
        result.published++;
      } catch (error) {
        discussionRelayCounter.add(1, { result: 'failed' });
        this.logger.warn(`event relay failed cause=${(error as Error).name}`);
        result.failed++;
      }
    }
    return result;
  }

  /** The envelope when the recorded event is valid; otherwise the reason (a short code, never the payload). */
  private parse(event: PendingEvent) {
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(event.envelope) as Record<string, unknown>;
    } catch {
      return 'unreadable';
    }
    const definition = registeredEventDefinitions().get(
      `${String(envelope.type)}@${String(envelope.version)}`,
    );
    if (!definition) return 'unknown_event';
    if (envelope.eventId !== event.eventId) return 'event_id_mismatch';
    try {
      const matched = definition.match(envelope as never);
      return matched ?? 'unknown_event';
    } catch {
      return 'invalid_payload';
    }
  }
}
