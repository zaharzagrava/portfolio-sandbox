import type { INestApplication } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';

/** What a spec may know about an outbox row: the contract (S53), not the table layout. */
export interface OutboxRowView {
  id: string;
  kind: 'event' | 'task';
  status: 'pending' | 'published' | 'parked';
  /** `<aggregateType>.events` for events, the queue name for tasks. */
  topic: string;
  aggregateId: string;
  aggregateType: string | null;
  /** Event type (`orders.order_paid`) or task type. */
  type: string | null;
  /** The envelope of an event; `{body, groupId?, delaySeconds?}` of a task until it is sent, then `{}`. */
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * The outbox rows written for one aggregate, oldest first. Test code only: domain specs use this instead of
 * querying `"Outbox"` themselves, so they do not depend on the table (constitution IX.6).
 */
export async function outboxRowsFor(
  source: INestApplication | Sequelize,
  aggregateId: string,
): Promise<OutboxRowView[]> {
  const sequelize =
    source instanceof Sequelize ? source : source.get(Sequelize);
  const [rows] = await sequelize.query(
    `SELECT "id", "kind", "status", "topic", "aggregateId", "aggregateType", "type", "payload", "attempts"
     FROM "Outbox" WHERE "aggregateId" = $1 ORDER BY "id"`,
    { bind: [aggregateId] },
  );
  return rows as OutboxRowView[];
}
