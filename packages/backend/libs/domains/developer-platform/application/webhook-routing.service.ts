import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { Clock, CLOCK } from '@app/common/core/clock';
import {
  PermanentError,
  TransientError,
} from '@app/infrastructure/projections/errors';
import { isApiVersion, LATEST_VERSION } from '../domain/versioning';
import {
  buildWebhookMessage,
  renderForVersion,
} from '../domain/webhook-event-mapper';
import type { WebhookEventType } from '../domain/webhook-events';
import {
  DeliveryLog,
  DeliveryQueue,
  RoutingReceipts,
  type DeliveryMessage,
} from '../domain/webhook-ports';
import {
  WEBHOOK_SETTINGS,
  type WebhookSettings,
} from '../domain/webhook-settings';
import { recordDeadLetter, webhookMetrics } from './webhook-metrics';
import { WebhookSubscriptions } from './webhook-subscriptions.service';

/** One webhook event for one shop, as the consumers derive it from a source event. */
export interface RoutedEvent {
  shopId: string;
  type: WebhookEventType;
  /** The outbound `evt_` id: deterministic from the source event and the shop (or from product and day for low stock). */
  eventId: string;
  /** The source event's time. */
  created: string;
  resource: 'order' | 'product' | 'payout';
  /** Null for events with no source aggregate version (low stock). */
  resourceVersion: number | null;
  object: Record<string, unknown>;
}

export interface SourceRef {
  eventId: string;
  occurredAt: string;
}

/** DynamoDB items are limited to 400 KB; a body this large cannot be stored, let alone delivered. */
const MAX_STORED_BODY_BYTES = 380_000;
const RECEIPT_POLL_MS = 50;
const RECEIPT_POLL_ROUNDS = 300;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Source event -> deliveries (S43 FR-021 to FR-028). One receipt per `(group, source event)`: the first handler routes,
 * a repeat acknowledges without effect, a handler running at the same moment waits for the first (and takes over if it
 * failed). Every body is rendered once, in the pinned version of its endpoint, and stored with the delivery record
 * (conditional put on `(endpoint, event)`, so a repeat never overwrites); the lane message carries no body. The receipt
 * is completed only after the queue accepted every message: if it rejects any, the source event is not acknowledged and
 * its redelivery completes the rest, with deterministic ids, without duplicates.
 */
@Injectable()
export class WebhookRoutingService {
  private readonly logger = new Logger(WebhookRoutingService.name);

  constructor(
    private readonly subscriptions: WebhookSubscriptions,
    private readonly log: DeliveryLog,
    private readonly queue: DeliveryQueue,
    private readonly receipts: RoutingReceipts,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WEBHOOK_SETTINGS) private readonly settings: WebhookSettings,
  ) {}

  async route(
    group: string,
    source: SourceRef,
    events: RoutedEvent[],
  ): Promise<'routed' | 'duplicate'> {
    return this.once(group, source.eventId, (retry) =>
      this.fanOut(events, source, retry),
    );
  }

  /**
   * Runs `work` once per `(group, source event)`: a repeat acknowledges without effect. `retryOfFailed` tells the work
   * that an earlier handling of the same event failed before it was acknowledged.
   */
  async once(
    group: string,
    sourceEventId: string,
    work: (retryOfFailed: boolean) => Promise<void>,
  ): Promise<'routed' | 'duplicate'> {
    const claim = await this.claimReceipt(group, sourceEventId);
    if (!claim) return 'duplicate';
    try {
      await work(claim.attempts > 1);
      await this.receipts.complete(group, sourceEventId);
      return 'routed';
    } catch (error) {
      await this.receipts.fail(group, sourceEventId);
      throw error;
    }
  }

  /** The claim of a free or failed receipt; null when the event was handled already. */
  private async claimReceipt(
    group: string,
    sourceEventId: string,
  ): Promise<{ attempts: number } | null> {
    for (let round = 0; round < RECEIPT_POLL_ROUNDS; round++) {
      const claim = await this.receipts.claim(group, sourceEventId);
      if (claim.outcome === 'claimed') return { attempts: claim.attempts };
      if (claim.outcome === 'done') return null;
      await sleep(RECEIPT_POLL_MS);
    }
    throw new TransientError(
      'the source event is being handled by another consumer for too long',
    );
  }

  private async fanOut(
    events: RoutedEvent[],
    source: SourceRef,
    retryOfFailed: boolean,
  ): Promise<void> {
    const now = this.clock.now();
    const expiresAt = new Date(
      now.getTime() + this.settings.logTtlDays * 86_400_000,
    );
    const messages: DeliveryMessage[] = [];
    for (const event of events) {
      const subscribers = await this.subscriptions.subscribers(
        event.shopId,
        event.type,
      );
      const made = await Promise.all(
        subscribers.map(async (subscriber): Promise<DeliveryMessage | null> => {
          const version = isApiVersion(subscriber.apiVersion)
            ? subscriber.apiVersion
            : LATEST_VERSION;
          const body = buildWebhookMessage({
            eventId: event.eventId,
            type: event.type,
            created: event.created,
            apiVersion: version,
            resourceVersion: event.resourceVersion,
            object: renderForVersion(event.resource, event.object, version),
          });
          if (Buffer.byteLength(body) > MAX_STORED_BODY_BYTES) {
            recordDeadLetter('router', event.eventId);
            throw new PermanentError(
              `the ${event.type} body is too large to store`,
            );
          }
          const deliveryId = uuidv7();
          const created = await this.log.createDelivery({
            endpointId: subscriber.id,
            shopId: event.shopId,
            eventId: event.eventId,
            deliveryId,
            type: event.type,
            kind: 'event',
            state: 'queued',
            attempt: 1,
            nextAttemptAt: null,
            claimedAt: null,
            body,
            createdAt: now,
            expiresAt,
          });
          if (created === 'created')
            return {
              endpointId: subscriber.id,
              eventId: event.eventId,
              deliveryId,
              kind: 'event',
              attempt: 1,
            };
          // Exists: a repeat of the same event (nothing more to do), or the remains of a handling that failed before the
          // queue accepted the message (this is its retry): put the still pending one into the lane again.
          if (!retryOfFailed) return null;
          const existing = await this.log.getDelivery(
            subscriber.id,
            event.eventId,
            now,
          );
          return existing?.state === 'queued'
            ? {
                endpointId: subscriber.id,
                eventId: event.eventId,
                deliveryId: existing.deliveryId,
                kind: 'event',
                attempt: 1,
              }
            : null;
        }),
      );
      for (const message of made) if (message) messages.push(message);
    }
    await this.queue.enqueueMany(messages);
    webhookMetrics
      .routingLag()
      .record(
        Math.max(0, (now.getTime() - Date.parse(source.occurredAt)) / 1000),
      );
    if (messages.length > 0)
      this.logger.debug(`routed ${messages.length} deliveries`);
  }
}
