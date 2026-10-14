import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChatOfflineNotifyBody } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { CHAT_OFFLINE_QUEUE } from '../domain/chat.constants';
import {
  chatEscalationFailedCounter,
  chatOfflineCheckCounter,
} from '../domain/chat-metrics';
import {
  decideEscalation,
  type EscalationOutcome,
} from '../domain/escalation-decision';
import {
  PORTS,
  type CoalescingSlot,
  type EscalationFactsPort,
  type EscalationOutbox,
  type PresenceReader,
} from '../domain/ports';

export { CHAT_OFFLINE_QUEUE };

const PREVIEW_MAX = 120;

/**
 * The delayed offline check (S24 US6, R-07). It reads the facts through ports, decides with the pure
 * `decideEscalation`, and only for `notified` takes the coalescing slot and appends `chat.message_escalated`:
 *
 *  - unknown presence counts as offline and an unreachable coalescing store is skipped: a duplicate push (stopped
 *    downstream by `dedupeKey`) is better than a missed one (AS-45);
 *  - the slot is taken pending before the append and confirmed after it; a refused append releases it, is counted and
 *    rethrown so the queue retries (up to its max receive count, then the dead-letter queue; AS-47).
 */
@Injectable()
export class ChatOfflineCheckService {
  private readonly log = new Logger(ChatOfflineCheckService.name);

  constructor(
    @Inject(PORTS.EscalationFactsPort)
    private readonly facts: EscalationFactsPort,
    @Inject(PORTS.PresenceReader) private readonly presence: PresenceReader,
    @Inject(PORTS.CoalescingSlot) private readonly slot: CoalescingSlot,
    @Inject(PORTS.EscalationOutbox) private readonly outbox: EscalationOutbox,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(body: ChatOfflineNotifyBody): Promise<EscalationOutcome> {
    const { channelId, messageId, recipientId } = body;
    const facts = await this.facts.load({ channelId, messageId, recipientId });
    const online = await this.presence.isOnline(recipientId);
    const decided = decideEscalation({
      eligible: facts.eligible,
      deleted: facts.deleted,
      readSeq: facts.readSeq,
      seq: body.seq,
      online,
      coalesced: false,
    });
    if (decided !== 'notified') return this.done(decided);

    const now = this.clock.now();
    let token: string | null = null;
    try {
      const taken = await this.slot.take(recipientId, channelId, now);
      if (!taken) return this.done('coalesced');
      token = taken.token;
    } catch (error) {
      this.log.warn(
        `coalescing store unavailable, notifying anyway reason=${(error as Error).message}`,
      );
    }

    try {
      await this.outbox.append(
        {
          recipientId,
          channelId,
          channelTitle: facts.channelTitle,
          messageId,
          seq: body.seq,
          authorId: body.authorId,
          preview: [...body.preview].slice(0, PREVIEW_MAX).join(''),
          dedupeKey: `chat:${messageId}:${recipientId}`,
        },
        now,
      );
    } catch (error) {
      chatEscalationFailedCounter.add(1);
      if (token)
        await this.slot
          .release(recipientId, channelId, token)
          .catch(() => undefined);
      this.log.warn(
        `escalation not appended channelId=${channelId} messageId=${messageId} reason=${(error as Error).message}`,
      );
      throw error;
    }
    if (token)
      await this.slot
        .confirm(recipientId, channelId, token, now)
        .catch(() => undefined);
    return this.done('notified');
  }

  private done(outcome: EscalationOutcome): EscalationOutcome {
    chatOfflineCheckCounter.add(1, { outcome });
    return outcome;
  }
}
