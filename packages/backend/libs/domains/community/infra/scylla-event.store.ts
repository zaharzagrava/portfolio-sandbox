import { Injectable } from '@nestjs/common';
import { types } from 'cassandra-driver';
import type { EventStore, PendingEvent, RecordedEvent } from '../domain/ports';
import { eventStatements } from './event-rows';
import { ScyllaStore } from './scylla-store';

/** Recorded events and the relay work queue (S25 G1, R-3). */
@Injectable()
export class ScyllaEventStore implements EventStore {
  constructor(private readonly store: ScyllaStore) {}

  async record(event: RecordedEvent): Promise<void> {
    await this.store.batch(eventStatements(event));
  }

  async pending(hourShards: string[], limit: number): Promise<PendingEvent[]> {
    const out: PendingEvent[] = [];
    for (const shard of hourShards) {
      if (out.length >= limit) break;
      const result = await this.store.read(
        'SELECT hour_shard, event_id, type, aggregate_id, occurred_at, payload FROM pending_events WHERE hour_shard = ? LIMIT ?',
        [types.Long.fromString(shard), limit - out.length],
      );
      for (const row of result.rows)
        out.push({
          hourShard: row.hour_shard.toString(),
          eventId: row.event_id.toString(),
          type: row.type,
          aggregateId: row.aggregate_id,
          occurredAt: row.occurred_at,
          envelope: row.payload,
        });
    }
    return out;
  }

  async delivered(event: PendingEvent): Promise<void> {
    await this.store.write(
      'DELETE FROM pending_events WHERE hour_shard = ? AND event_id = ?',
      [types.Long.fromString(event.hourShard), event.eventId],
    );
  }

  async deadLetter(
    event: PendingEvent,
    reason: string,
    day: number,
  ): Promise<void> {
    await this.store.batch([
      {
        query:
          'INSERT INTO dead_events (day, event_id, reason, payload) VALUES (?, ?, ?, ?)',
        params: [day, event.eventId, reason, event.envelope],
      },
      {
        query:
          'DELETE FROM pending_events WHERE hour_shard = ? AND event_id = ?',
        params: [types.Long.fromString(event.hourShard), event.eventId],
      },
    ]);
  }
}
