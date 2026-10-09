import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';

/**
 * Keeps only the highest `aggregateVersion` per aggregate, in the order the aggregates first appeared. The caller
 * counts the dropped events as `coalesced`. Valid only for state-carrying events (FR-033).
 */
export function coalesceLatest(events: EventEnvelope[]): EventEnvelope[] {
  const latest = new Map<string, EventEnvelope>();
  for (const event of events) {
    const key = `${event.aggregateType}:${event.aggregateId}`;
    const current = latest.get(key);
    if (!current || event.aggregateVersion >= current.aggregateVersion)
      latest.set(key, event);
  }
  return [...latest.values()];
}
