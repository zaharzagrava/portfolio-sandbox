import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { InvalidEventPayloadError } from '@app/infrastructure/events/event-errors';
import { PermanentError } from '@app/infrastructure/projections/errors';

/**
 * `definition.match(event)` with an invalid payload as a dead letter (`PermanentError`) instead of a thrown contract
 * error: nothing is written for an event that fails its schema (S27 AS-55, AS-97). `null` for another type or version.
 */
export function matchEvent<D extends { match(e: EventEnvelope): unknown }>(
  definition: D,
  event: EventEnvelope,
  onInvalid: (type: string) => PermanentError,
): ReturnType<D['match']> {
  try {
    return definition.match(event) as ReturnType<D['match']>;
  } catch (error) {
    if (error instanceof InvalidEventPayloadError) throw onInvalid(event.type);
    throw error;
  }
}
