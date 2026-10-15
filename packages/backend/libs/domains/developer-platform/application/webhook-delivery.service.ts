import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { WEBHOOK_HEADERS } from '@marketplace-sandbox/contracts';
import { Clock, CLOCK } from '@app/common/core/clock';
import { SecretBox } from '@app/domains/identity';
import {
  breakerStatus,
  decideBreaker,
  type BreakerConfig,
} from '../domain/breaker';
import { nextRetry, type RetryScheduleConfig } from '../domain/retry-schedule';
import { signWebhook } from '../domain/signature';
import {
  BreakerStore,
  DeliveryLog,
  DeliveryQueue,
  EndpointRepository,
  OutboundHttp,
  RandomSource,
  type AttemptError,
  type AttemptRecord,
  type CancelReason,
  type DeliveryMessage,
  type DeliveryRecord,
  type DeliveryTransition,
  type EndpointRecord,
  type OutboundResult,
  deliveryKey,
} from '../domain/webhook-ports';
import {
  WEBHOOK_SETTINGS,
  type WebhookSettings,
} from '../domain/webhook-settings';
import { WebhookLifecycleService } from './webhook-lifecycle.service';
import { breakerWatch, webhookMetrics } from './webhook-metrics';
import { signingSecrets } from './webhook-secrets';
import './webhook-jobs'; // declares the job type `webhooks.retry`

/** The queue message of the ordered lane (no body, no secret). Anything else is a poison message. */
export const deliveryMessageSchema = z.object({
  endpointId: z.string().min(1),
  eventId: z.string().min(1),
  deliveryId: z.string().min(1),
  kind: z.enum(['event', 'replay', 'ping']),
  attempt: z.number().int().positive(),
  scheduledFor: z.string().optional(),
});

export class InvalidDeliveryMessageError extends Error {
  constructor() {
    super('the message is not a webhook delivery');
    this.name = 'InvalidDeliveryMessageError';
  }
}

/**
 * The attempt failed inside the ordered lane (attempts 1 and 2): the message is not acknowledged, so the queue shows it
 * again after its visibility timeout, 30 s later, and the endpoint's lane waits meanwhile (FR-032). Not a fault.
 */
export class WebhookRedeliverError extends Error {
  constructor() {
    super('delivery failed in the ordered lane; redeliver');
    this.name = 'WebhookRedeliverError';
  }
}

export type DeliveryOutcome =
  /** `2xx` answer. */
  | 'delivered'
  /** Failed; the next attempt is in the retry lane (a job puts it back into the ordered lane). */
  | 'retry_scheduled'
  /** The 11th attempt failed. */
  | 'exhausted'
  /** Not sent: the body is over the cap. */
  | 'failed'
  /** Not sent: the endpoint is disabled or deleted. */
  | 'cancelled'
  /** Not sent: the breaker is open or another delivery holds the probe. */
  | 'breaker_skipped'
  /** Nothing to do: already delivered, terminal, superseded, in flight elsewhere, or unknown. */
  | 'skipped';

type Plan =
  | { kind: 'claim'; attempt: number }
  | { kind: 'repair'; at: Date; attempt: number }
  | { kind: 'skip' };

/**
 * One attempt of one delivery (S43 FR-030 to FR-040), shared by the SQS worker and the Lambda host. The state of the
 * delivery lives in the log store: the attempt is claimed atomically (so a duplicate or concurrent message sends
 * nothing), the endpoint's status is read from the store (a disable or delete takes effect at the next attempt), the
 * circuit breaker may hold the delivery back, and the outcome (the attempt item and the next state) is written in one
 * step. A store failure before the send fails the message, which the queue redelivers (and dead-letters after five
 * receives); a failure after the send leaves the attempt in doubt, and the repeat consumes the next attempt number.
 * No network call happens inside a database transaction.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  private readonly retry: RetryScheduleConfig;
  private readonly breakerConfig: BreakerConfig;

  constructor(
    private readonly endpoints: EndpointRepository,
    private readonly log: DeliveryLog,
    private readonly queue: DeliveryQueue,
    private readonly http: OutboundHttp,
    private readonly breaker: BreakerStore,
    private readonly random: RandomSource,
    private readonly box: SecretBox,
    private readonly lifecycle: WebhookLifecycleService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WEBHOOK_SETTINGS) private readonly settings: WebhookSettings,
  ) {
    this.retry = {
      laneAttempts: settings.laneAttempts,
      laneDelayMs: settings.laneDelayMs,
      delaysMs: settings.retryDelaysMs,
      jitter: settings.jitter,
      maxDelayMs: settings.maxRetryDelayMs,
    };
    this.breakerConfig = {
      failureThreshold: settings.breakerFailureThreshold,
      baseOpenMs: settings.breakerBaseOpenMs,
      maxOpenMs: settings.breakerMaxOpenMs,
      probeWaitMs: settings.breakerProbeWaitMs,
    };
  }

  /** Parses a raw queue body; a body that is not a delivery message throws `InvalidDeliveryMessageError`. */
  static parse(raw: unknown): DeliveryMessage {
    const parsed = deliveryMessageSchema.safeParse(raw);
    if (!parsed.success) throw new InvalidDeliveryMessageError();
    return parsed.data;
  }

  async handle(
    message: DeliveryMessage,
    receiveCount = 1,
  ): Promise<DeliveryOutcome> {
    void receiveCount; // the queue's redrive policy counts receives; the delivery's own attempt number is in the store
    const current = await this.log.getDelivery(
      message.endpointId,
      deliveryKey(message),
      this.clock.now(),
    );
    if (!current) return 'skipped'; // purged, expired or never stored: nothing to send

    const plan = this.plan(current, message);
    if (plan.kind === 'skip') return 'skipped';
    if (plan.kind === 'repair') {
      // The retry of a later attempt was recorded but its job may not have been written (the worker died in between): the
      // job has a deterministic key, so scheduling it again is harmless when it exists.
      await this.queue.scheduleRetry(
        {
          endpointId: current.endpointId,
          eventId: current.eventId,
          deliveryId: current.deliveryId,
          kind: current.kind,
          attempt: plan.attempt,
        },
        plan.at,
      );
      return 'skipped';
    }

    const claim = await this.log.claim(
      message.endpointId,
      deliveryKey(message),
      plan.attempt,
      this.clock.now(),
      this.settings.attemptTimeoutMs + 5_000,
    );
    if (!claim.claimed) return 'skipped';
    // How long this delivery waited for a worker: since it was queued, or since its retry was due.
    const since =
      current.state === 'retry_scheduled' && current.nextAttemptAt
        ? current.nextAttemptAt
        : current.createdAt;
    webhookMetrics
      .laneAge()
      .set(Math.max(0, (this.clock.now().getTime() - since.getTime()) / 1000));
    return this.attempt(claim.delivery);
  }

  // ------------------------------------------------------------ planning

  /**
   * Which attempt this message may claim. A message names the attempt it was queued for; the ordered lane re-shows the
   * same message for attempts 2 and 3, so an older number inside the lane is the delivery's current attempt. Anything
   * else older is a duplicate of a message that was handled.
   */
  private plan(current: DeliveryRecord, message: DeliveryMessage): Plan {
    switch (current.state) {
      case 'delivered':
      case 'exhausted':
      case 'cancelled':
      case 'failed':
        return { kind: 'skip' };
      case 'queued':
      case 'retry_scheduled':
      case 'delivering': {
        if (message.attempt === current.attempt)
          return { kind: 'claim', attempt: current.attempt };
        const lane = this.settings.laneAttempts;
        if (message.attempt > current.attempt) return { kind: 'skip' };
        if (current.attempt <= lane && message.kind === 'event')
          return { kind: 'claim', attempt: current.attempt };
        if (current.state === 'retry_scheduled' && current.nextAttemptAt)
          return {
            kind: 'repair',
            at: current.nextAttemptAt,
            attempt: current.attempt,
          };
        return { kind: 'skip' };
      }
      default: {
        const never: never = current.state;
        throw new Error(`unknown delivery state ${String(never)}`);
      }
    }
  }

  // ------------------------------------------------------------ one attempt

  private async attempt(delivery: DeliveryRecord): Promise<DeliveryOutcome> {
    const n = delivery.attempt;
    const endpoint = await this.endpoints.findForDelivery(delivery.endpointId);
    if (!endpoint) return this.cancel(delivery, 'endpoint_deleted');
    if (endpoint.status !== 'enabled')
      return this.cancel(delivery, 'endpoint_disabled');

    const startedAt = this.clock.now();
    if (Buffer.byteLength(delivery.body) > this.settings.bodyCapBytes) {
      await this.record({
        attempt: this.attemptItem(delivery, n, startedAt, {
          kind: 'failure',
          error: 'payload_too_large',
          durationMs: 0,
        }),
        next: {
          state: 'failed',
          attempt: n,
          failureReason: 'payload_too_large',
        },
      });
      webhookMetrics.attempts().add(1, { outcome: 'failed' });
      return 'failed';
    }

    const isEvent = delivery.kind === 'event';
    if (isEvent) {
      const held = await this.breakerHold(delivery, startedAt.getTime());
      if (held) return 'breaker_skipped';
    }

    const result = await this.http.post({
      url: endpoint.url,
      headers: this.headers(endpoint, delivery, n, startedAt.getTime()),
      body: delivery.body,
      timeoutMs: this.settings.attemptTimeoutMs,
      maxResponseBytes: this.settings.responseReadCapBytes,
    });
    const ok =
      result.kind === 'response' && result.status >= 200 && result.status < 300;

    const item = this.attemptItem(delivery, n, startedAt, result);
    webhookMetrics.duration().record(item.durationMs / 1000);
    webhookMetrics
      .attempts()
      .add(1, { outcome: this.outcomeLabel(ok, result) });
    this.logAttempt(endpoint, delivery, item, ok);

    if (ok) {
      await this.record({
        attempt: item,
        next: { state: 'delivered', attempt: n },
      });
      if (isEvent) await this.afterSuccess(endpoint);
      return 'delivered';
    }

    // A replay or a test event is one attempt: it never retries and never touches health (FR-043).
    if (!isEvent) {
      await this.record({
        attempt: item,
        next: { state: 'failed', attempt: n },
      });
      return 'failed';
    }

    const decision = nextRetry(
      {
        attempt: n,
        random: this.random.next(),
        retryAfterSec:
          result.kind === 'response' ? result.retryAfterSec : undefined,
      },
      this.retry,
    );
    if (decision.kind === 'exhausted') {
      await this.record({
        attempt: item,
        next: { state: 'exhausted', attempt: n },
      });
      await this.afterFailure(endpoint, startedAt);
      return 'exhausted';
    }
    const nextAt = new Date(this.clock.now().getTime() + decision.delayMs);
    await this.record({
      attempt: item,
      next: { state: 'retry_scheduled', attempt: n + 1, nextAttemptAt: nextAt },
    });
    await this.afterFailure(endpoint, startedAt);
    if (decision.lane === 'ordered') throw new WebhookRedeliverError();
    await this.queue.scheduleRetry(
      {
        endpointId: delivery.endpointId,
        eventId: delivery.eventId,
        deliveryId: delivery.deliveryId,
        kind: delivery.kind,
        attempt: n + 1,
      },
      nextAt,
    );
    return 'retry_scheduled';
  }

  /** True when the breaker holds the delivery back: it is given back to the store and rescheduled for the close time. */
  private async breakerHold(
    delivery: DeliveryRecord,
    nowMs: number,
  ): Promise<boolean> {
    const state = await this.breaker.get(delivery.endpointId);
    const decision = decideBreaker(state, nowMs, this.breakerConfig);
    let until: number | null = null;
    if (decision.action === 'skip') until = decision.until;
    else if (decision.action === 'probe') {
      const won = await this.breaker.acquireProbe(
        delivery.endpointId,
        this.settings.attemptTimeoutMs + 5_000,
      );
      if (!won) until = nowMs + this.breakerConfig.probeWaitMs;
      else {
        // The probe lease is won; a probe that finished between our read and our win has re-opened the breaker: look again.
        const fresh = await this.breaker.get(delivery.endpointId);
        if (breakerStatus(fresh, nowMs, this.breakerConfig) === 'open')
          until = fresh.openUntil;
      }
    }
    if (until === null) return false;
    breakerWatch.opened(delivery.endpointId);

    const runAt = new Date(until);
    await this.log.release(
      delivery.endpointId,
      deliveryKey(delivery),
      delivery.attempt,
      runAt,
    );
    await this.queue.scheduleRetry(
      {
        endpointId: delivery.endpointId,
        eventId: delivery.eventId,
        deliveryId: delivery.deliveryId,
        kind: delivery.kind,
        attempt: delivery.attempt,
      },
      runAt,
    );
    webhookMetrics.attempts().add(1, { outcome: 'breaker_skipped' });
    return true;
  }

  private async cancel(
    delivery: DeliveryRecord,
    reason: CancelReason,
  ): Promise<DeliveryOutcome> {
    await this.log.cancel(delivery.endpointId, deliveryKey(delivery), reason);
    webhookMetrics.attempts().add(1, { outcome: 'cancelled' });
    return 'cancelled';
  }

  // ------------------------------------------------------------ health effects (events only)

  /** Best effort after the outcome is durable: a failing side store must not turn a delivered event into a redelivery. */
  private async afterSuccess(endpoint: EndpointRecord): Promise<void> {
    await this.breaker.recordSuccess(endpoint.id);
    breakerWatch.closed(endpoint.id);
    await this.endpoints
      .markHealthy(endpoint.id)
      .catch((error: Error) =>
        this.logger.warn(
          `could not clear the failure window: ${error.message}`,
        ),
      );
  }

  private async afterFailure(
    endpoint: EndpointRecord,
    at: Date,
  ): Promise<void> {
    const state = await this.breaker.recordFailure(endpoint.id, at.getTime());
    if (breakerStatus(state, at.getTime(), this.breakerConfig) !== 'closed')
      breakerWatch.opened(endpoint.id);
    // The first failure after a success opens the window; a failure at or after its third day switches the endpoint off
    // in the same step (FR-042). The sweep covers the endpoints no attempt reaches any more.
    try {
      const since = await this.endpoints.markFailing(endpoint.id, at);
      if (this.lifecycle.windowExpired(since, at))
        await this.lifecycle.autoDisable(endpoint.id);
    } catch (error) {
      this.logger.warn(
        `could not update the failure window: ${(error as Error).message}`,
      );
    }
  }

  // ------------------------------------------------------------ request and records

  private headers(
    endpoint: EndpointRecord,
    delivery: DeliveryRecord,
    attempt: number,
    nowMs: number,
  ): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'User-Agent': 'Marketplace-Webhooks/1',
      [WEBHOOK_HEADERS.signature]: signWebhook(
        delivery.body,
        signingSecrets(this.box, endpoint, nowMs),
        nowMs,
      ),
      [WEBHOOK_HEADERS.eventId]: delivery.eventId,
      [WEBHOOK_HEADERS.deliveryId]: delivery.deliveryId,
      [WEBHOOK_HEADERS.eventType]: delivery.type,
      [WEBHOOK_HEADERS.attempt]: String(attempt),
      ...(delivery.kind === 'replay' ? { [WEBHOOK_HEADERS.replay]: '1' } : {}),
    };
  }

  private attemptItem(
    delivery: DeliveryRecord,
    attempt: number,
    startedAt: Date,
    result:
      | OutboundResult
      | { kind: 'failure'; error: AttemptError; durationMs: number },
  ): AttemptRecord {
    const response = result.kind === 'response';
    const snippet = response
      ? Buffer.from(result.snippet).subarray(0, 1024).toString('utf8')
      : '';
    return {
      endpointId: delivery.endpointId,
      deliveryId: delivery.deliveryId,
      eventId: delivery.eventId,
      type: delivery.type,
      attemptId: uuidv7(),
      attempt,
      startedAt,
      durationMs: Math.max(0, Math.round(result.durationMs)),
      status: response ? result.status : null,
      ok: response && result.status >= 200 && result.status < 300,
      ...(response ? {} : { error: result.error }),
      ...(snippet ? { responseSnippet: snippet } : {}),
      replay: delivery.kind === 'replay',
      expiresAt: new Date(
        this.clock.now().getTime() + this.settings.logTtlDays * 86_400_000,
      ),
    };
  }

  private record(outcome: {
    attempt: AttemptRecord;
    next: DeliveryTransition;
  }): Promise<void> {
    return this.log.recordAttempt(outcome.attempt, outcome.next);
  }

  private outcomeLabel(ok: boolean, result: OutboundResult): string {
    if (ok) return 'delivered';
    if (result.kind === 'failure') {
      if (result.error === 'timeout') return 'timeout';
      if (
        result.error === 'blocked_address' ||
        result.error === 'unresolvable' ||
        result.error === 'invalid_url'
      )
        return 'blocked';
    }
    return 'failed';
  }

  /**
   * One structured line per attempt (FR-052): correlation (a delivery attempt has no HTTP request, so the attempt's own
   * id), delivery, endpoint, event, attempt number, status and host. Never the address path or query, a header, the
   * signature, a secret or the body.
   */
  private logAttempt(
    endpoint: EndpointRecord,
    delivery: DeliveryRecord,
    item: AttemptRecord,
    ok: boolean,
  ): void {
    const line = {
      action: 'webhook.attempt',
      requestId: `webhook-attempt:${delivery.deliveryId}:${item.attempt}`,
      deliveryId: delivery.deliveryId,
      endpointId: endpoint.id,
      eventId: delivery.eventId,
      kind: delivery.kind,
      attempt: item.attempt,
      status: item.status,
      ...(item.error ? { error: item.error } : {}),
      outcome: ok ? 'delivered' : 'failed',
      durationMs: item.durationMs,
      host: this.hostOf(endpoint),
    };
    if (ok) this.logger.log(line);
    else this.logger.warn(line);
  }

  /** The host only: a URL can carry a secret in its path or query, and never reaches a log. */
  private hostOf(endpoint: EndpointRecord): string {
    try {
      return new URL(endpoint.url).host;
    } catch {
      return 'invalid';
    }
  }
}
