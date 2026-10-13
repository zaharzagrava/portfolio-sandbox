import { types } from 'cassandra-driver';
import { hourOf } from '../domain/months';
import type { RecordedEvent } from '../domain/ports';
import type { Statement } from './scylla-store';

export const SHARDS_PER_HOUR = 8;

/** Relay shard: the hour, spread over 8 partitions by the aggregate id so one hour never makes one hot partition. */
export function hourShard(at: Date, aggregateId: string): number {
  let sum = 0;
  for (const ch of aggregateId)
    sum = (sum + ch.charCodeAt(0)) % SHARDS_PER_HOUR;
  return hourOf(at) * SHARDS_PER_HOUR + sum;
}

/** The two rows that make an event durable with the write that caused it and put it on the relay's work queue. */
export function eventStatements(event: RecordedEvent): Statement[] {
  return [
    {
      query:
        'INSERT INTO recorded_events (event_id, type, version, aggregate_id, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
      params: [
        event.eventId,
        event.type,
        event.version,
        event.aggregateId,
        event.occurredAt,
        event.envelope,
      ],
    },
    {
      query:
        'INSERT INTO pending_events (hour_shard, event_id, type, aggregate_id, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
      params: [
        types.Long.fromNumber(hourShard(event.occurredAt, event.aggregateId)),
        event.eventId,
        event.type,
        event.aggregateId,
        event.occurredAt,
        event.envelope,
      ],
    },
  ];
}
