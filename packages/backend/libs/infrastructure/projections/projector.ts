import type { ZodType } from 'zod';
import type { EventDefinition } from '@app/infrastructure/events/define-event';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';

export { SinkBackpressureError } from './errors';
export { coalesceLatest } from './coalesce';

/** How a consumer copes with the same event arriving twice (S53 FR-025). */
export type IdempotencyMechanism = 'inbox' | 'versionGuard' | 'natural';

/**
 * One event contract a consumer handles. `event` is the version the handler understands; `upgradeFrom` lists the
 * steps that lift older versions to it: `upcast` turns the payload of `version` into the payload of `version + 1`,
 * so the chain from version 1 to a handled version 3 needs steps for 1 and 2.
 */
export interface HandledEvent {
  event: EventDefinition<string, string, any>;
  upgradeFrom?: { version: number; upcast: (payload: unknown) => unknown }[];
}

/** What a handler or sink did with the events it was given; every event not counted is taken as `applied`. */
export interface SinkCounts {
  applied: number;
  duplicate: number;
  stale: number;
}

/**
 * A consumer of the log: a read-model builder or any other reader. The framework gives it validated, upgraded
 * envelopes in batches (per partition, in order) and owns offsets, retries, dead letters and shutdown.
 */
export interface Projector {
  /** Consumer group id: one per consumer, so each keeps its own offsets, lag and dead letters. */
  readonly name: string;
  readonly topics: string[];
  /** How a duplicate is made harmless; startup fails without one. */
  readonly idempotency: IdempotencyMechanism;
  /**
   * The event contracts this consumer handles. Unknown types are skipped, newer versions dead-lettered, older ones
   * upgraded, and every payload is validated before `project` sees it.
   */
  readonly handles: HandledEvent[];
  /**
   * A batch is reduced to the highest `aggregateVersion` per aggregate before `project` (ten price updates to one
   * product in a 50 ms batch become one write). Only valid when every event on the topic carries full state.
   */
  readonly coalesce?: boolean;
  /** Handler attempts per event before the dead-letter topic (default 3). */
  readonly attempts?: number;
  /** False: the group is never rewound by replay without an explicit override (default true). */
  readonly replayable?: boolean;
  /** Aggregate ids must match this schema (for example a UUID), otherwise the message is dead-lettered. */
  readonly aggregateIdSchema?: ZodType;
  /**
   * Applies the events. Throw `TransientError`/`SinkBackpressureError` for an unwell store, `PermanentError` for an
   * event that can never be applied. May return the sinks' outcome counts for the metrics.
   */
  project(events: EventEnvelope[]): Promise<void | SinkCounts>;
}
