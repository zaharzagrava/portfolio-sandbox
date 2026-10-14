import { Injectable } from '@nestjs/common';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { ChatMessageEscalated } from '../application/events/chat-events';
import type { Escalation, EscalationOutbox } from '../domain/ports';

/**
 * `chat.message_escalated` through the outbox, in its own short transaction (IV.3, IX.6): chat says what happened, the
 * notifications capability decides who is told and how. The aggregate is the recipient (the topic key), the aggregate
 * version the injected clock in ms (strictly increasing per recipient). A refusal throws: the caller releases its slot.
 */
@Injectable()
export class OutboxEscalationAdapter implements EscalationOutbox {
  constructor(
    private readonly outbox: OutboxService,
    private readonly runner: TransactionRunner,
  ) {}

  append(escalation: Escalation, now: Date): Promise<void> {
    return this.runner.run(async () => {
      await this.outbox.append(
        ChatMessageEscalated.create(
          escalation.recipientId,
          now.getTime(),
          escalation,
          now,
        ),
      );
    });
  }
}
