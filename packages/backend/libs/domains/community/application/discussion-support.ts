import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import type { EventDefinition } from '@app/infrastructure/events/define-event';
import type { z } from 'zod';
import { idTime, TimeIdGenerator, type RandomSource } from '../domain/ids';
import { RANDOM_BYTES, type RecordedEvent } from '../domain/ports';

/** Who is asking. `moderator` is true for `ADMIN` and `MODERATOR` (FR-052). */
export interface Viewer {
  userId: string | null;
  moderator: boolean;
}

export const ANONYMOUS: Viewer = { userId: null, moderator: false };

/** Hash of an `Idempotency-Key` header (the claim table never stores the raw key). */
export const keyHash = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

/** New time-based ids from the injected clock (S25 FR-003): the embedded time is `createdAt`. */
@Injectable()
export class DiscussionIds {
  private readonly generator: TimeIdGenerator;

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RANDOM_BYTES) random: RandomSource,
  ) {
    this.generator = new TimeIdGenerator(random);
  }

  next(): { id: string; createdAt: Date } {
    const id = this.generator.next(this.clock.now());
    return { id, createdAt: idTime(id) };
  }

  now(): Date {
    return this.clock.now();
  }
}

/** Builds a validated event envelope and the record that stores it with the write (S25 R-3). */
export function recordEvent<
  TType extends string,
  TAggregate extends string,
  TSchema extends z.ZodType,
>(
  definition: EventDefinition<TType, TAggregate, TSchema>,
  postId: string,
  payload: z.input<TSchema>,
  occurredAt: Date,
): RecordedEvent {
  const envelope = definition.create(
    postId,
    0,
    payload as z.infer<TSchema>,
    occurredAt,
  );
  return {
    eventId: envelope.eventId,
    type: envelope.type,
    version: envelope.version,
    aggregateId: postId,
    occurredAt,
    envelope: JSON.stringify(envelope),
  };
}
