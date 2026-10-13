import { Inject, Injectable, Logger } from '@nestjs/common';
import { v4 } from 'uuid';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  CALLBACK_ATTEMPT_ATTRIBUTE,
  EARLY_CALLBACK_WINDOW_MS,
  callbackMessageSchema,
  earlyCallbackDelaySeconds,
  type CallbackMessage,
  type SesCallback,
  type SmsCallback,
} from '../domain/callbacks';
import {
  callbacksCounter,
  callbacksDroppedCounter,
  deadLetterCounter,
} from '../domain/metrics';
import {
  CALLBACK_QUEUE,
  CLAIM_STORE,
  DEAD_LETTER_SINK,
  DEDUPE_STORE,
  DELIVERY_TIMELINE_STORE,
  type CallbackQueue,
  type ClaimStore,
  type DeadLetterSink,
  type DedupeStore,
  type DeliveryTimelineStore,
} from '../domain/ports';
import type { DeliveryStatus } from '../domain/types';
import { callbackKey } from './callback-intake.service';
import { PreferencesService } from './preferences.service';
import { SuppressionService } from './suppression.service';

/** Queue name of accepted callbacks (the adapter's constant, repeated here for dead letters: `application/` imports no `infra/`). */
const SOURCE = 'notifications-callbacks';
const CLAIM_TTL_MS = 60_000;
/** A copy of a callback being applied right now waits this long for the other to finish. */
const CLAIM_WAIT_MS = 3_000;
const CLAIM_POLL_MS = 100;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface CallbackQueueMessage {
  id: string;
  body: unknown;
  attributes?: Record<string, string>;
}

type Outcome = 'applied' | 'deferred' | 'dropped';

/**
 * What the consumer of `notifications-callbacks` does with one accepted callback (FR-043..FR-045). The effects are
 * idempotent and guarded twice: a claim on the provider event id while applying and a done marker after, so ten copies
 * of one callback apply once and a crash mid-way leaves the message to be redelivered. Suppression comes first (it needs
 * no delivery); the status part then follows the forward-only timeline rule. A callback whose provider message id is
 * not mapped yet raced our own timeline write: it is put back with a growing delay for up to 10 minutes, then dropped
 * with `notifications_callbacks_dropped_total{reason="unknown_message"}`. Bodies hold addresses: they are never logged.
 */
@Injectable()
export class CallbackWorkerService {
  private readonly logger = new Logger(CallbackWorkerService.name);
  private readonly workerId = v4();

  constructor(
    @Inject(DELIVERY_TIMELINE_STORE)
    private readonly timeline: DeliveryTimelineStore,
    @Inject(CLAIM_STORE) private readonly claims: ClaimStore,
    @Inject(DEDUPE_STORE) private readonly dedupe: DedupeStore,
    @Inject(DEAD_LETTER_SINK) private readonly deadLetters: DeadLetterSink,
    @Inject(CALLBACK_QUEUE) private readonly queue: CallbackQueue,
    private readonly tasks: TaskQueue,
    private readonly suppression: SuppressionService,
    private readonly preferences: PreferencesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async process(message: CallbackQueueMessage): Promise<void> {
    const parsed = callbackMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      await this.deadLetter(message);
      this.logger.warn(
        `notifications.callback.invalid_message messageId=${message.id} fields=${parsed.error.issues.map((i) => i.path.join('.') || '(body)').join(',')}`,
      );
      return;
    }
    const callback = parsed.data;
    const key = callbackKey(callback.provider, callback.eventId);

    if (await this.dedupe.isDone(key)) return this.count(callback, 'duplicate');
    if (!(await this.claims.claim(key, this.workerId, CLAIM_TTL_MS))) {
      // A copy is being applied right now: if it finishes, there is nothing left to do.
      if (await this.doneSoon(key)) return this.count(callback, 'duplicate');
      throw new Error(
        `callback ${callback.provider} is claimed by another worker`,
      );
    }
    try {
      if (await this.dedupe.isDone(key))
        return this.count(callback, 'duplicate');
      const outcome = await this.apply(
        callback,
        Number(message.attributes?.[CALLBACK_ATTEMPT_ATTRIBUTE] ?? 1) || 1,
      );
      // A deferred callback is not done: its re-queued copy applies the status part later.
      if (outcome !== 'deferred') await this.dedupe.markDone(key);
      this.count(callback, outcome);
    } finally {
      await this.claims.release(key, this.workerId);
    }
  }

  private async apply(
    callback: CallbackMessage,
    attempt: number,
  ): Promise<Outcome> {
    const { payload } = callback;
    if (callback.provider === 'ses')
      return this.applySes(callback, payload as SesCallback, attempt);
    return this.applySms(callback, payload as SmsCallback, attempt);
  }

  private async applySes(
    callback: CallbackMessage,
    event: SesCallback,
    attempt: number,
  ): Promise<Outcome> {
    // The address part needs no delivery of ours, so it is applied (idempotently) before the status part.
    if (event.kind === 'complaint')
      await this.suppression.suppress('email', event.recipients, 'complaint');
    if (event.kind === 'bounce' && event.bounceType === 'Permanent')
      await this.suppression.suppress('email', event.recipients, 'hard-bounce');

    const deliveryId = await this.timeline.findByProvider(
      'ses',
      event.messageId,
    );
    if (!deliveryId) return this.unknownMessage(callback, attempt);

    if (event.kind === 'delivery') await this.move(deliveryId, 'delivered');
    else if (event.kind === 'bounce')
      await this.move(
        deliveryId,
        event.bounceType === 'Permanent' ? 'bounced' : 'failed',
        event.bounceType,
      );
    else {
      await this.move(deliveryId, 'complained');
      // A spam complaint also switches marketing e-mail off for the account, when the account is known.
      const userId = (await this.timeline.find(deliveryId))?.userId;
      if (userId)
        await this.preferences.setCell(userId, 'marketing', 'email', false);
    }
    return 'applied';
  }

  private async applySms(
    callback: CallbackMessage,
    event: SmsCallback,
    attempt: number,
  ): Promise<Outcome> {
    // 21610: the recipient replied STOP, a legally binding opt-out that holds without any delivery of ours.
    if (event.errorCode === '21610' && event.to)
      await this.suppression.suppress('sms', [event.to], 'sms-stop');

    const deliveryId = await this.timeline.findByProvider(
      'twilio',
      event.messageId,
    );
    if (!deliveryId) return this.unknownMessage(callback, attempt);

    if (event.status === 'delivered') await this.move(deliveryId, 'delivered');
    else await this.move(deliveryId, 'failed', event.errorCode);
    return 'applied';
  }

  private async move(
    deliveryId: string,
    status: DeliveryStatus,
    detail?: string,
  ): Promise<void> {
    await this.timeline.advance(deliveryId, {
      status,
      ...(detail !== undefined && { detail }),
      at: this.clock.now(),
    });
  }

  /** The callback raced our own write (or never had one): hold it for the early-callback window, then drop it. */
  private async unknownMessage(
    callback: CallbackMessage,
    attempt: number,
  ): Promise<Outcome> {
    const age = this.clock.now().getTime() - Date.parse(callback.acceptedAt);
    if (age >= EARLY_CALLBACK_WINDOW_MS) {
      callbacksDroppedCounter.add(1, { reason: 'unknown_message' });
      return 'dropped';
    }
    await this.queue.accept(callback, {
      delaySeconds: earlyCallbackDelaySeconds(attempt),
      attempt: attempt + 1,
    });
    return 'deferred';
  }

  private async doneSoon(key: string): Promise<boolean> {
    for (let waited = 0; waited < CLAIM_WAIT_MS; waited += CLAIM_POLL_MS) {
      await sleep(CLAIM_POLL_MS);
      if (await this.dedupe.isDone(key)) return true;
    }
    return false;
  }

  private count(
    callback: CallbackMessage,
    outcome: Outcome | 'duplicate',
  ): void {
    callbacksCounter.add(1, { provider: callback.provider, outcome });
  }

  /** The queue's dead-letter move, by hand; the record never holds the body (it carries addresses). */
  private async deadLetter(message: CallbackQueueMessage): Promise<void> {
    await this.tasks.enqueue(`${SOURCE}-dlq`, message.body ?? null, {
      attributes: { deadLetterReason: 'invalid_message' },
    });
    await this.deadLetters.record({
      source: SOURCE,
      reason: 'invalid_message',
      eventId: message.id,
      at: this.clock.now(),
    });
    deadLetterCounter.add(1, { source: SOURCE, reason: 'invalid_message' });
  }
}
