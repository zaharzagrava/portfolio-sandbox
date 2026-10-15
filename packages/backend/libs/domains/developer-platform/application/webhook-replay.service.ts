import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import {
  WEBHOOK_EVENT_ID_PATTERN,
  type WebhookAttemptDto,
} from '@marketplace-sandbox/contracts';
import { Clock, CLOCK } from '@app/common/core/clock';
import { isApiVersion, LATEST_VERSION } from '../domain/versioning';
import { buildWebhookMessage } from '../domain/webhook-event-mapper';
import { deriveWebhookEventId } from '../domain/webhook-events';
import {
  endpointDisabled,
  endpointNotFound,
  eventNotFound,
  serviceUnavailable,
  WebhookError,
} from '../domain/webhook-errors';
import {
  DeliveryLog,
  DeliveryQueue,
  EndpointRepository,
  type AttemptRecord,
  type DeliveryKind,
  type DeliveryRecord,
  type EndpointRecord,
} from '../domain/webhook-ports';
import {
  WEBHOOK_SETTINGS,
  type WebhookSettings,
} from '../domain/webhook-settings';

export interface AttemptPage {
  items: WebhookAttemptDto[];
  nextCursor: string | null;
}

export interface EventDetail {
  eventId: string;
  type: DeliveryRecord['type'];
  createdAt: string;
  state: DeliveryRecord['state'];
  attempts: number;
  body: Record<string, unknown>;
}

export interface AcceptedDelivery {
  deliveryId: string;
  eventId: string;
  endpointId: string;
  state: 'queued';
}

const encodeCursor = (a: { startedAt: Date; attemptId: string }): string =>
  Buffer.from(
    JSON.stringify({ s: a.startedAt.toISOString(), a: a.attemptId }),
  ).toString('base64url');

function decodeCursor(cursor: string): { startedAt: Date; attemptId: string } {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { s?: unknown; a?: unknown };
    const startedAt = new Date(String(parsed.s));
    if (
      typeof parsed.a !== 'string' ||
      parsed.a.length === 0 ||
      parsed.a.length > 64 ||
      Number.isNaN(startedAt.getTime())
    )
      throw new Error('bad cursor');
    return { startedAt, attemptId: parsed.a };
  } catch {
    throw new WebhookError('invalid_cursor', 'The cursor is not valid.');
  }
}

const toAttemptDto = (a: AttemptRecord): WebhookAttemptDto => ({
  attemptId: a.attemptId,
  deliveryId: a.deliveryId,
  eventId: a.eventId,
  type: a.type,
  attempt: a.attempt,
  startedAt: a.startedAt.toISOString(),
  durationMs: a.durationMs,
  status: a.status,
  ok: a.ok,
  ...(a.error ? { error: a.error } : {}),
  ...(a.responseSnippet ? { responseSnippet: a.responseSnippet } : {}),
  replay: a.replay,
});

/**
 * The delivery log and the operator's tools on it (S43 FR-045 to FR-047): the attempt log and the event detail, replay of a
 * stored event and the per-endpoint test event. Replay and ping only write a `queued` delivery and put it into the
 * endpoint's ordered lane; the receiver is called by the worker, never inside the HTTP request (III.3). Every lookup
 * carries the shop, so an endpoint of another shop is an unknown endpoint, and an event is looked up under its endpoint,
 * so another endpoint's event is an unknown event.
 */
@Injectable()
export class WebhookReplayService {
  constructor(
    private readonly endpoints: EndpointRepository,
    private readonly log: DeliveryLog,
    private readonly queue: DeliveryQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WEBHOOK_SETTINGS) private readonly settings: WebhookSettings,
  ) {}

  private async require(
    shopId: string,
    endpointId: string,
  ): Promise<EndpointRecord> {
    const endpoint = await this.endpoints.findById(shopId, endpointId);
    if (!endpoint) throw endpointNotFound();
    return endpoint;
  }

  // ------------------------------------------------------------ reads

  /** Newest first by `(startedAt, attemptId)`; the cursor resumes after the last item, so a new attempt shifts nothing. */
  async listAttempts(
    shopId: string,
    endpointId: string,
    query: {
      eventId?: string;
      ok?: 'true' | 'false';
      limit: number;
      cursor?: string;
    },
  ): Promise<AttemptPage> {
    await this.require(shopId, endpointId);
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.log.listAttempts(
      endpointId,
      {
        ...(query.eventId ? { eventId: query.eventId } : {}),
        ...(query.ok ? { ok: query.ok === 'true' } : {}),
        limit: query.limit + 1,
        after,
      },
      this.clock.now(),
    );
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toAttemptDto),
      nextCursor:
        rows.length > query.limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  async eventDetail(
    shopId: string,
    endpointId: string,
    eventId: string,
  ): Promise<EventDetail> {
    await this.require(shopId, endpointId);
    const delivery = await this.original(endpointId, eventId);
    const attempts = await this.log.countAttempts(
      endpointId,
      eventId,
      this.clock.now(),
    );
    return {
      eventId: delivery.eventId,
      type: delivery.type,
      createdAt: delivery.createdAt.toISOString(),
      state: delivery.state,
      attempts,
      body: JSON.parse(delivery.body) as Record<string, unknown>,
    };
  }

  /** The delivery stored for an event id; a replay record has a key of its own and is never reachable by an event id. */
  private async original(
    endpointId: string,
    eventId: string,
  ): Promise<DeliveryRecord> {
    if (!WEBHOOK_EVENT_ID_PATTERN.test(eventId)) throw eventNotFound();
    const delivery = await this.log.getDelivery(
      endpointId,
      eventId,
      this.clock.now(),
    );
    if (!delivery) throw eventNotFound();
    return delivery;
  }

  // ------------------------------------------------------------ replay and ping

  /** Re-sends the stored body unchanged: one more attempt, no retry, no effect on health (FR-043, FR-046). */
  async replay(
    shopId: string,
    endpointId: string,
    eventId: string,
  ): Promise<AcceptedDelivery> {
    const endpoint = await this.require(shopId, endpointId);
    if (endpoint.status !== 'enabled') throw endpointDisabled();
    const original = await this.original(endpointId, eventId);
    return this.accept(endpoint, 'replay', {
      eventId: original.eventId,
      type: original.type,
      body: original.body,
    });
  }

  /** A signed `webhook.ping` to this endpoint only, even if it does not subscribe to it (FR-047). */
  async ping(shopId: string, endpointId: string): Promise<AcceptedDelivery> {
    const endpoint = await this.require(shopId, endpointId);
    if (endpoint.status !== 'enabled') throw endpointDisabled();
    const eventId = deriveWebhookEventId('ping', uuidv7());
    const version = isApiVersion(endpoint.apiVersion)
      ? endpoint.apiVersion
      : LATEST_VERSION;
    return this.accept(endpoint, 'ping', {
      eventId,
      type: 'webhook.ping',
      body: buildWebhookMessage({
        eventId,
        type: 'webhook.ping',
        created: this.clock.now().toISOString(),
        apiVersion: version,
        resourceVersion: null,
        object: { object: 'ping' },
      }),
    });
  }

  private async accept(
    endpoint: EndpointRecord,
    kind: Exclude<DeliveryKind, 'event'>,
    event: Pick<DeliveryRecord, 'eventId' | 'type' | 'body'>,
  ): Promise<AcceptedDelivery> {
    const now = this.clock.now();
    const deliveryId = uuidv7();
    const created = await this.log.createDelivery({
      endpointId: endpoint.id,
      shopId: endpoint.shopId,
      eventId: event.eventId,
      deliveryId,
      type: event.type,
      kind,
      state: 'queued',
      attempt: 1,
      nextAttemptAt: null,
      claimedAt: null,
      body: event.body,
      createdAt: now,
      expiresAt: new Date(
        now.getTime() + this.settings.logTtlDays * 86_400_000,
      ),
    });
    if (created === 'exists') throw serviceUnavailable(); // a fresh delivery id cannot collide: refuse rather than guess
    try {
      await this.queue.enqueue({
        endpointId: endpoint.id,
        eventId: event.eventId,
        deliveryId,
        kind,
        attempt: 1,
      });
    } catch {
      // The record stays `queued` with no message: inert, and gone with the log's expiry. The client may retry.
      throw serviceUnavailable();
    }
    return {
      deliveryId,
      eventId: event.eventId,
      endpointId: endpoint.id,
      state: 'queued',
    };
  }
}
