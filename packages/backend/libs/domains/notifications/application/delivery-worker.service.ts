import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import {
  NOTIFICATION_TYPES,
  typeDef,
  type NotificationType,
} from '../domain/catalog';
import { channelEnabled } from '../domain/channel-resolution';
import { backoffSeconds, MAX_DELIVERY_ATTEMPTS } from '../domain/backoff';
import { deliveryMessageSchema } from '../domain/delivery-message';
import { scrub } from '../domain/scrub';
import { deadLetterQueueOf, lineOfQueue } from '../domain/lines';
import {
  deadLetterCounter,
  deliveryCounter,
  deliveryLatencyHistogram,
  expiredCounter,
  limiterUnavailableCounter,
} from '../domain/metrics';
import {
  CLAIM_STORE,
  DEAD_LETTER_SINK,
  DELIVERY_TIMELINE_STORE,
  PROVIDER_CHAINS,
  type ClaimStore,
  type DeadLetterSink,
  type DeliveryTimelineStore,
  type DeliveryUpdate,
  type ProviderChains,
} from '../domain/ports';
import {
  DeadLetterReason,
  DeliveryMessage,
  PermanentDeliveryError,
} from '../domain/types';
import { DeviceService } from './device.service';
import { RecipientViewService } from './recipient-view.service';
import { SuppressionService } from './suppression.service';
import './notification-delivery.job-types';

const CLAIM_TTL_MS = 90_000;
/** A copy of a message that is being sent by another worker waits this long for the other to finish. */
const CLAIM_WAIT_MS = 3_000;
const CLAIM_POLL_MS = 100;
/** SQS accepts a delay of at most 15 minutes. */
const MAX_DELAY_S = 900;
/** A marketing delivery that cannot get a budget decision (limiter store down) comes back after this long (FR-028). */
const LIMITER_DOWN_DELAY_S = 60;
/** Attempt number of a message on its line; absent on the first. */
const ATTEMPT_ATTRIBUTE = 'attempt';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LineMessage {
  id: string;
  body: unknown;
  attributes: Record<string, string>;
}

/**
 * What the consumer of a delivery line does with one message (FR-027 to FR-033). In order: validate the body, take the
 * `sent` marker and the atomic claim (a delivery id reaches a provider once even when the standard queue hands over a
 * duplicate), check at send time the maximum age, the user's current preference, the devices and the suppression list,
 * draw the provider's send budget, walk the provider chain, record the outcome.
 *
 * The line itself is the retry layer: a transient failure of the whole chain puts the message back on its line with a
 * full-jitter backoff and the attempt number in a message attribute; the 5th failure moves it to the line's dead-letter
 * queue by hand and records `failed`/`exhausted`. An over-budget message is put back without costing an attempt.
 */
@Injectable()
export class DeliveryWorkerService {
  private readonly logger = new Logger(DeliveryWorkerService.name);
  private readonly workerId = randomUUID();
  /** Uniform in `[0, 1)`; the jitter of the backoff. */
  readonly random: () => number = Math.random;

  constructor(
    private readonly queue: TaskQueue,
    private readonly limiter: RateLimiterService,
    private readonly suppression: SuppressionService,
    private readonly devices: DeviceService,
    private readonly views: RecipientViewService,
    @Inject(DELIVERY_TIMELINE_STORE)
    private readonly timeline: DeliveryTimelineStore,
    @Inject(CLAIM_STORE) private readonly claims: ClaimStore,
    @Inject(DEAD_LETTER_SINK) private readonly deadLetters: DeadLetterSink,
    @Inject(PROVIDER_CHAINS) private readonly chains: ProviderChains,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async process(queue: string, message: LineMessage): Promise<void> {
    const parsed = deliveryMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      await this.deadLetter(queue, message, 'invalid_message');
      this.logger.warn(
        `notifications.delivery.invalid_message queue=${queue} messageId=${message.id} fields=${parsed.error.issues.map((i) => i.path.join('.') || '(body)').join(',')}`,
      );
      return;
    }
    const m = parsed.data;

    if (await this.claims.sentMarker(m.deliveryId)) return;
    if (!(await this.claims.claim(m.deliveryId, this.workerId, CLAIM_TTL_MS))) {
      // A copy of this message is being sent right now: if it finishes, there is nothing left to do.
      if (await this.sentSoon(m.deliveryId)) return;
      throw new Error(`delivery ${m.deliveryId} is claimed by another worker`);
    }

    let sent = false;
    try {
      sent = await this.send(
        queue,
        m,
        Number(message.attributes[ATTEMPT_ATTRIBUTE]) || 1,
      );
    } finally {
      // The sent marker guards a finished delivery; any other end frees the claim for the retry.
      if (!sent) await this.claims.release(m.deliveryId, this.workerId);
    }
  }

  private async sentSoon(deliveryId: string): Promise<boolean> {
    for (let waited = 0; waited < CLAIM_WAIT_MS; waited += CLAIM_POLL_MS) {
      await sleep(CLAIM_POLL_MS);
      if (await this.claims.sentMarker(deliveryId)) return true;
    }
    return false;
  }

  /** True when the message reached a provider. */
  private async send(
    queue: string,
    m: DeliveryMessage,
    attempt: number,
  ): Promise<boolean> {
    const line = lineOfQueue(queue);

    if (m.staleAt && this.clock.now() >= new Date(m.staleAt)) {
      expiredCounter.add(1, { type: m.type });
      await this.record(queue, m, { status: 'expired' });
      return false;
    }

    const recipients = await this.currentRecipients(m);
    if (recipients.skip) {
      await this.record(queue, m, {
        status: recipients.skip.status,
        detail: recipients.skip.detail,
      });
      return false;
    }
    const to: string[] = [];
    for (const address of recipients.to)
      if (!(await this.suppression.isSuppressed(m.channel, address)))
        to.push(address);
    if (to.length === 0) {
      await this.record(queue, m, {
        status: 'suppressed',
        ...(recipients.noDevice && { detail: 'no_device' }),
      });
      return false;
    }

    const chain = this.chains[m.channel];
    const decision = await this.limiter.check(
      line === 'marketing'
        ? BUDGET_POLICIES.marketing[m.channel]
        : BUDGET_POLICIES.transactional[m.channel],
      chain.primary,
    );
    if (
      decision.source === 'fallback' ||
      decision.reason === 'store-unavailable'
    )
      limiterUnavailableCounter.add(1, { priority: line });
    if (!decision.allowed) {
      // Over the provider's send rate, or no answer from the limiter for a marketing send (fail closed): back on the
      // line without costing an attempt.
      const delay =
        decision.reason === 'store-unavailable'
          ? LIMITER_DOWN_DELAY_S
          : Math.min(
              Math.max(Math.ceil((decision.retryAfterMs ?? 60_000) / 1000), 1),
              MAX_DELAY_S,
            );
      await this.putBack(queue, m, attempt, delay);
      return false;
    }

    try {
      const result = await chain.send({ ...m, to });
      if (result.invalidTokens?.length)
        await this.devices.removeByTokens(result.invalidTokens);
      await this.claims.markSent(m.deliveryId, result.providerMessageId);
      await this.record(queue, m, {
        status: 'sent',
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        ...(result.failover && { failover: true }),
      });
      if (m.routedAt)
        deliveryLatencyHistogram.record(
          Math.max(this.clock.now().getTime() - Date.parse(m.routedAt), 0) /
            1000,
          { channel: m.channel, line },
        );
      this.logger.log(
        `notifications.delivery.sent ${this.who(m)} provider=${result.provider}`,
      );
      try {
        await this.timeline.linkProvider(
          result.provider,
          result.providerMessageId,
          m.deliveryId,
        );
      } catch (error) {
        this.logger.warn(
          `provider lookup not written for ${m.deliveryId}: ${scrub((error as Error).message)}`,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof PermanentDeliveryError) {
        await this.permanent(queue, m, to, error);
        return false;
      }
      this.logger.warn(
        `notifications.delivery.transient channel=${m.channel} deliveryId=${m.deliveryId} attempt=${attempt}: ${scrub((error as Error).message)}`,
      );
      if (attempt >= MAX_DELIVERY_ATTEMPTS) {
        await this.deadLetter(
          queue,
          { body: m, id: m.deliveryId },
          'exhausted',
        );
        await this.record(queue, m, { status: 'failed', detail: 'exhausted' });
        this.logger.warn(
          `notifications.delivery.failed ${this.who(m)} reason=exhausted`,
        );
        return false;
      }
      await this.putBack(
        queue,
        m,
        attempt + 1,
        Math.min(Math.ceil(backoffSeconds(attempt, this.random)), MAX_DELAY_S),
      );
      return false;
    }
  }

  /**
   * Who the message may still go to, judged on the user's choices now (FR-033): a non-mandatory type the user switched
   * off since is `skipped`; push goes only to tokens that are still registered devices.
   */
  private async currentRecipients(m: DeliveryMessage): Promise<{
    to: string[];
    noDevice?: boolean;
    skip?: { status: 'skipped'; detail: string };
  }> {
    if (!m.userId) return { to: m.to };
    const view = await this.views.view(m.userId);
    if (!view) return { to: m.to };
    if (
      m.type in NOTIFICATION_TYPES &&
      !channelEnabled(
        typeDef(m.type as NotificationType),
        view.overrides,
        m.channel,
      )
    )
      return { to: [], skip: { status: 'skipped', detail: 'preference' } };
    if (m.channel !== 'push') return { to: m.to };
    const registered = new Set(view.devices.map((d) => d.token));
    const to = m.to.filter((token) => registered.has(token));
    return { to, noDevice: to.length === 0 };
  }

  /** "This address will never work": no failover, no retry; the address or token goes away (FR-030). */
  private async permanent(
    queue: string,
    m: DeliveryMessage,
    to: string[],
    error: PermanentDeliveryError,
  ): Promise<void> {
    if (m.channel === 'push') await this.devices.removeByTokens(error.suppress);
    else {
      const addresses = error.suppress.length ? error.suppress : to;
      await this.suppression.suppress(
        m.channel,
        addresses,
        'provider-permanent',
      );
    }
    // The provider's wording often quotes the address it refused: scrubbed before it is stored or logged.
    await this.record(queue, m, {
      status: 'failed',
      detail: scrub(error.message),
    });
    this.logger.warn(
      `notifications.delivery.failed ${this.who(m)} reason=permanent`,
    );
  }

  /** The only fields a delivery log line carries: user id, type, channel and delivery id (never an address or text). */
  private who(m: DeliveryMessage): string {
    return `userId=${m.userId || '-'} type=${m.type} channel=${m.channel} deliveryId=${m.deliveryId}`;
  }

  private async putBack(
    queue: string,
    m: DeliveryMessage,
    attempt: number,
    delaySeconds: number,
  ): Promise<void> {
    await this.queue.enqueue(queue, m, {
      delaySeconds,
      attributes: { [ATTEMPT_ATTRIBUTE]: String(attempt) },
    });
  }

  /** The line's dead-letter move, by hand: the message goes to `<line>-dlq`; the record never holds its body. */
  private async deadLetter(
    queue: string,
    message: Pick<LineMessage, 'id' | 'body'>,
    reason: DeadLetterReason,
  ): Promise<void> {
    await this.queue.enqueue(deadLetterQueueOf(queue), message.body ?? null, {
      attributes: { deadLetterReason: reason },
    });
    await this.deadLetters.record({
      source: queue,
      reason,
      eventId: message.id,
      at: this.clock.now(),
    });
    deadLetterCounter.add(1, { source: queue, reason });
  }

  /** A timeline write never fails or repeats a send (FR-012). */
  private async record(
    queue: string,
    m: DeliveryMessage,
    update: Omit<DeliveryUpdate, 'at'>,
  ): Promise<void> {
    deliveryCounter.add(1, {
      channel: m.channel,
      line: lineOfQueue(queue),
      status: update.status,
    });
    try {
      await this.timeline.advance(m.deliveryId, {
        ...update,
        at: this.clock.now(),
      });
    } catch (error) {
      this.logger.warn(
        `delivery timeline write failed for ${m.deliveryId}: ${scrub((error as Error).message)}`,
      );
    }
  }
}

/** S50 send budgets (`rate-limit-policies.ts`): marketing draws on its own, smaller one per channel. */
const BUDGET_POLICIES = {
  transactional: {
    email: 'notify.email',
    sms: 'notify.sms',
    push: 'notify.push',
  },
  marketing: {
    email: 'notify.email.marketing',
    sms: 'notify.sms.marketing',
    push: 'notify.push.marketing',
  },
} as const;
