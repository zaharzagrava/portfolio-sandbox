import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  isSnsHttpsUrl,
  type CallbackMessage,
  type SesCallback,
} from '../domain/callbacks';
import { callbacksCounter } from '../domain/metrics';
import {
  CALLBACK_QUEUE,
  DEDUPE_STORE,
  type CallbackQueue,
  type DedupeStore,
} from '../domain/ports';

/** Identity under which a callback is deduplicated by both the intake and the worker. */
export const callbackKey = (provider: string, eventId: string) =>
  `cb:${provider}:${eventId}`;

const recipients = (list: Array<{ emailAddress: string }> | undefined) =>
  (list ?? []).map((r) => r.emailAddress);

const sesEventSchema = z
  .object({
    eventType: z.string().optional(),
    notificationType: z.string().optional(),
    mail: z.object({ messageId: z.string().min(1).max(200) }),
    bounce: z
      .object({
        bounceType: z.enum(['Permanent', 'Transient', 'Undetermined']),
        bouncedRecipients: z.array(
          z.object({ emailAddress: z.string().min(1).max(320) }),
        ),
      })
      .optional(),
    complaint: z
      .object({
        complainedRecipients: z.array(
          z.object({ emailAddress: z.string().min(1).max(320) }),
        ),
      })
      .optional(),
    delivery: z
      .object({ recipients: z.array(z.string().max(320)).optional() })
      .optional(),
  })
  .passthrough();

export type IntakeResult = 'accepted' | 'duplicate' | 'ignored';

/** Outcomes of an Twilio status that change our records; the others (queued, sent, ...) are acknowledged and ignored. */
const SMS_STATUSES = new Set(['delivered', 'undelivered', 'failed']);

/**
 * Provider callbacks, after their signature was verified by the caller: reduced to a queue message and durably accepted
 * (FR-043). The caller answers `200` as soon as `accept*` resolves; applying the effects is the worker's (AS-70). A
 * callback already applied is not queued again. Nothing here is logged beyond counters: bodies hold addresses.
 */
@Injectable()
export class CallbackIntakeService {
  constructor(
    @Inject(CALLBACK_QUEUE) private readonly queue: CallbackQueue,
    @Inject(DEDUPE_STORE) private readonly dedupe: DedupeStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `messageId` is the SNS MessageId (the event identity), `inner` the verified SNS `Message` string. */
  async acceptSes(messageId: string, inner: string): Promise<IntakeResult> {
    let raw: unknown;
    try {
      raw = JSON.parse(inner);
    } catch {
      throw new BadRequestException('The notification is not JSON');
    }
    const parsed = sesEventSchema.safeParse(raw);
    if (!parsed.success)
      throw new BadRequestException('Not an e-mail provider event');
    const event = parsed.data;
    const kind = event.eventType ?? event.notificationType;
    const payload = this.sesPayload(kind, event);
    if (payload === 'invalid')
      throw new BadRequestException('Incomplete e-mail provider event');
    if (!payload) {
      callbacksCounter.add(1, { provider: 'ses', outcome: 'ignored' });
      return 'ignored';
    }
    return this.accept({
      provider: 'ses',
      eventId: messageId,
      acceptedAt: this.clock.now().toISOString(),
      payload,
    });
  }

  private sesPayload(
    kind: string | undefined,
    event: z.infer<typeof sesEventSchema>,
  ): SesCallback | 'invalid' | null {
    const messageId = event.mail.messageId;
    if (kind === 'Bounce')
      return event.bounce
        ? {
            kind: 'bounce',
            messageId,
            bounceType: event.bounce.bounceType,
            recipients: recipients(event.bounce.bouncedRecipients),
          }
        : 'invalid';
    if (kind === 'Complaint')
      return event.complaint
        ? {
            kind: 'complaint',
            messageId,
            recipients: recipients(event.complaint.complainedRecipients),
          }
        : 'invalid';
    if (kind === 'Delivery')
      return {
        kind: 'delivery',
        messageId,
        recipients: event.delivery?.recipients ?? [],
      };
    return null;
  }

  /** `params` are the verified form fields of a Twilio status callback. */
  async acceptSms(params: Record<string, unknown>): Promise<IntakeResult> {
    const sid = params.MessageSid;
    const status = params.MessageStatus;
    if (
      typeof sid !== 'string' ||
      typeof status !== 'string' ||
      !sid ||
      !status
    )
      throw new BadRequestException('Not an SMS status callback');
    if (!SMS_STATUSES.has(status)) {
      callbacksCounter.add(1, { provider: 'twilio', outcome: 'ignored' });
      return 'ignored';
    }
    const text = (value: unknown) =>
      typeof value === 'string' && value ? value : undefined;
    return this.accept({
      provider: 'twilio',
      // The scheme has no timestamp and no event id: a replay is the same sid and status.
      eventId: `${sid}:${status}`,
      acceptedAt: this.clock.now().toISOString(),
      payload: {
        kind: 'status',
        messageId: sid,
        status,
        ...(text(params.ErrorCode) && { errorCode: text(params.ErrorCode) }),
        ...(text(params.To) && { to: text(params.To) }),
      },
    });
  }

  /** The URL to confirm a verified SNS subscription must be on the provider's own HTTPS host (AS-73). */
  assertSubscribeUrl(url: string | undefined): string {
    if (!url || !isSnsHttpsUrl(url))
      throw new BadRequestException(
        'The subscription URL is not on the provider host',
      );
    return url;
  }

  private async accept(callback: CallbackMessage): Promise<IntakeResult> {
    if (
      await this.dedupe.isDone(callbackKey(callback.provider, callback.eventId))
    ) {
      callbacksCounter.add(1, {
        provider: callback.provider,
        outcome: 'duplicate',
      });
      return 'duplicate';
    }
    await this.queue.accept(callback);
    callbacksCounter.add(1, {
      provider: callback.provider,
      outcome: 'accepted',
    });
    return 'accepted';
  }
}
