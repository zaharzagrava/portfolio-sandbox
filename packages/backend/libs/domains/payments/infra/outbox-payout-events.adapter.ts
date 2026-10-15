import { Injectable } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import type { PayoutEventsPort } from '../domain/payout-ports';

/** Appends a payout event to the outbox in the transition's own transaction; the relay delivers it later. */
@Injectable()
export class OutboxPayoutEvents implements PayoutEventsPort {
  constructor(private readonly outbox: OutboxService) {}

  append(event: EventEnvelope, tx: Transaction): Promise<void> {
    return this.outbox.append(event, tx);
  }
}
