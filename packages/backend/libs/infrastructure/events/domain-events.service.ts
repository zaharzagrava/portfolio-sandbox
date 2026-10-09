import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Transaction } from 'sequelize';
import Outbox from '@app/infrastructure/outbox/outbox.model';
import { EventEnvelope } from './event-envelope';

/**
 * Records domain events through the transactional outbox (README #1): call it
 * inside the same transaction as the state change, so "state changed" and
 * "event will be published" commit or roll back together. With Sequelize CLS
 * (F-01) the current transaction is picked up automatically; pass `tx` only
 * when you hold one explicitly.
 */
@Injectable()
export class DomainEventsService {
  constructor(
    @InjectModel(Outbox) private readonly outboxModel: typeof Outbox,
  ) {}

  async record(
    events: EventEnvelope | EventEnvelope[],
    tx?: Transaction,
  ): Promise<void> {
    const list = Array.isArray(events) ? events : [events];
    if (list.length === 0) return;

    await this.outboxModel.bulkCreate(
      list.map((event) => ({
        topic: `${event.aggregateType}.events`,
        aggregateId: event.aggregateId,
        eventName: event.eventName,
        payload: event,
        nextAttemptAt: new Date(),
      })),
      { transaction: tx },
    );
  }
}
