import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Transaction } from 'sequelize';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import {
  getActiveTransaction,
  TransactionRunner,
} from '@app/infrastructure/context';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { TopicRegistry } from '@app/infrastructure/events/topic-registry';
import {
  appendWithExecutor,
  buildInsert,
  eventRow,
  OutboxAppendInput,
  OutboxExecutor,
  OutboxTaskInput,
  taskRow,
} from './append-with-executor';
import { NoActiveTransactionError } from './outbox-errors';

export type { OutboxExecutor, OutboxTaskInput } from './append-with-executor';

/**
 * The only way to put events and tasks on the outbox (constitution IV.3, IX.6). Rows are written in the caller's
 * transaction so "state changed" and "event will be published" commit or roll back together; the relay (poller or
 * CDC) publishes them afterwards.
 */
@Injectable()
export class OutboxService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
    private readonly topics: TopicRegistry,
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = new SystemClock(),
  ) {}

  /**
   * Joins the active (CLS) transaction, or the explicit `transaction` of a caller that holds one; rejects with
   * `NoActiveTransactionError` when there is neither.
   */
  async append(
    events: EventEnvelope | EventEnvelope[],
    transaction?: Transaction,
  ): Promise<void> {
    const list = Array.isArray(events) ? events : [events];
    if (list.length === 0) return;
    const tx = transaction ?? getActiveTransaction();
    if (!tx) throw new NoActiveTransactionError(list.map((e) => e.type));
    await this.insertEvents(list, tx);
  }

  /** For an event with no state change of its own: its own short transaction. */
  async appendStandalone(
    events: EventEnvelope | EventEnvelope[],
  ): Promise<void> {
    const list = Array.isArray(events) ? events : [events];
    if (list.length === 0) return;
    await this.runner.run((tx) => this.insertEvents(list, tx));
  }

  /** A single-consumer task for a queue; same transaction rules as `append`. */
  async appendTask(
    task: OutboxTaskInput,
    transaction?: Transaction,
  ): Promise<void> {
    const tx = transaction ?? getActiveTransaction();
    if (!tx) throw new NoActiveTransactionError([task.type]);
    const { sql, params } = buildInsert([taskRow(task)], this.clock.now());
    await this.sequelize.query(sql, { bind: params, transaction: tx });
  }

  /** Framework-free append over a connection the caller owns (Lambda, scripts); see `appendWithExecutor`. */
  appendWithExecutor(
    executor: OutboxExecutor,
    input: OutboxAppendInput,
  ): Promise<void> {
    return appendWithExecutor(executor, input, { now: this.clock.now() });
  }

  /**
   * Operator: parked rows return to pending with `attempts` 0. Pass a row id, or filters (event type, parked
   * before `olderThan`). Returns how many rows were requeued.
   */
  async requeueParked(
    selector: string | { type?: string; olderThan?: Date },
  ): Promise<number> {
    const where = ['"status" = \'parked\''];
    const bind: unknown[] = [this.clock.now()];
    if (typeof selector === 'string') {
      bind.push(selector);
      where.push(`"id" = $${bind.length}`);
    } else {
      if (selector.type) {
        bind.push(selector.type);
        where.push(`"type" = $${bind.length}`);
      }
      if (selector.olderThan) {
        bind.push(selector.olderThan);
        where.push(`"createdAt" < $${bind.length}`);
      }
    }
    const [rows] = await this.sequelize.query(
      `UPDATE "Outbox" SET "status" = 'pending', "attempts" = 0, "parkedReason" = NULL, "leaseUntil" = NULL, "nextAttemptAt" = $1
       WHERE ${where.join(' AND ')} RETURNING "id"`,
      { bind },
    );
    return rows.length;
  }

  private async insertEvents(
    events: EventEnvelope[],
    tx: Transaction,
  ): Promise<void> {
    // Registry first: an unregistered aggregate type writes nothing, and the topic is never derived from a free string.
    const rows = events.map((event) =>
      eventRow(event, this.topics.topicFor(event.aggregateType)),
    );
    const { sql, params } = buildInsert(rows, this.clock.now());
    await this.sequelize.query(sql, { bind: params, transaction: tx });
  }
}
