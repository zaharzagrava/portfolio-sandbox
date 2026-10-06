import { EventEnvelope } from '@app/infrastructure/events/event-envelope';

/**
 * A read model builder. The runner gives it validated envelopes in batches
 * (per Kafka partition, in order); it writes them to its sink idempotently.
 */
export interface Projector {
  /** Kafka consumer group id - one per projector so each keeps its own offsets and can be rebuilt independently. */
  readonly name: string;
  readonly topics: string[];
  /**
   * When true, a batch is reduced to the latest version per aggregate before
   * `project` (coalescing): ten price updates to one product in a 50 ms batch
   * become one sink write. Only valid for "state" projections where the newest
   * version fully replaces older ones.
   */
  readonly coalesce?: boolean;
  project(events: EventEnvelope[]): Promise<void>;
}

/** Thrown by sinks when the downstream store is saturated - the runner pauses the partition and retries later. */
export class SinkBackpressureError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs = 1_000,
  ) {
    super(message);
    this.name = 'SinkBackpressureError';
  }
}

/** Keeps only the highest version per aggregate, preserving the order of first appearance. */
export function coalesceLatest(events: EventEnvelope[]): EventEnvelope[] {
  const latest = new Map<string, EventEnvelope>();
  for (const event of events) {
    const key = `${event.aggregateType}:${event.aggregateId}`;
    const current = latest.get(key);
    if (!current || event.version >= current.version) latest.set(key, event);
  }
  return [...latest.values()];
}
