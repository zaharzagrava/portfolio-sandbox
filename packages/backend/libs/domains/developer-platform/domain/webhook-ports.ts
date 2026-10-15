import type {
  EndpointUrlRejectionReason,
  WebhookDeliveryStateName,
  WebhookEventTypeName,
} from '@marketplace-sandbox/contracts';
import type { BreakerState } from './breaker';
import type { DisabledReason, EndpointStatus } from './endpoint-status';

/**
 * Ports of the webhook capability (S43 plan R-01, D-6): services depend on these, never on Sequelize, DynamoDB, Redis,
 * SQS or an HTTP client. Adapters live in `infra/`. Nothing here reads a clock or a random source: every instant and
 * every random value is passed in. Repository methods join the ambient transaction (`TransactionRunner.run`) so the
 * service can write the endpoint, its history row and its outbox event atomically.
 */

// ---------------------------------------------------------------- endpoints

export interface EndpointRecord {
  id: string;
  shopId: string;
  url: string;
  urlNormalized: string;
  events: WebhookEventTypeName[];
  apiVersion: string;
  status: EndpointStatus;
  disabledReason: DisabledReason | null;
  failingSince: Date | null;
  secretSealed: string;
  previousSecretSealed: string | null;
  previousSecretExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewEndpoint {
  /** Generated before the insert: the secret is sealed bound to `webhook-endpoint:<id>`. */
  id: string;
  shopId: string;
  url: string;
  urlNormalized: string;
  events: WebhookEventTypeName[];
  apiVersion: string;
  secretSealed: string;
  now: Date;
}

export type InsertEndpointOutcome =
  | { outcome: 'created'; endpoint: EndpointRecord }
  | { outcome: 'limit_reached' }
  | { outcome: 'duplicate_url' };

/** Result of a conditional statement: it applied, the condition failed against `current`, or no such endpoint in this shop. */
export type ConditionalOutcome =
  | { outcome: 'applied'; endpoint: EndpointRecord }
  | { outcome: 'conflict'; current: EndpointRecord }
  | { outcome: 'not_found' };

export interface EndpointPatch {
  url?: string;
  urlNormalized?: string;
  events?: WebhookEventTypeName[];
  apiVersion?: string;
}

export interface EndpointCursor {
  createdAt: Date;
  id: string;
}

export abstract class EndpointRepository {
  /** Counter increment (`WHERE endpoints < limit`, first use inserts the row) and insert, in the ambient transaction. */
  abstract insertWithinLimit(
    input: NewEndpoint,
    limit: number,
  ): Promise<InsertEndpointOutcome>;
  /** Always `WHERE id = :id AND "shopId" = :shopId`: an endpoint of another shop is "not found". */
  abstract findById(shopId: string, id: string): Promise<EndpointRecord | null>;
  /** Worker and router side, where the queue message carries only the endpoint id (never a user-supplied id). */
  abstract findForDelivery(id: string): Promise<EndpointRecord | null>;
  /** Keyset page ordered `(createdAt desc, id desc)`; returns up to `limit + 1` rows so the caller sees if more exist. */
  abstract listPage(
    shopId: string,
    page: { limit: number; after?: EndpointCursor },
  ): Promise<EndpointRecord[]>;
  abstract listEnabledForShop(shopId: string): Promise<EndpointRecord[]>;
  abstract update(
    shopId: string,
    id: string,
    patch: EndpointPatch,
    now: Date,
  ): Promise<
    | { outcome: 'applied'; endpoint: EndpointRecord; before: EndpointRecord }
    | { outcome: 'duplicate_url' }
    | { outcome: 'not_found' }
  >;
  /** `WHERE status = :from`; enabling clears `failingSince`, disabling records the reason. */
  abstract transition(
    shopId: string,
    id: string,
    from: EndpointStatus,
    to: { status: EndpointStatus; disabledReason: DisabledReason | null },
    now: Date,
  ): Promise<ConditionalOutcome>;
  /** Removes the row and decrements the shop counter; null when the endpoint is not in this shop. */
  abstract delete(shopId: string, id: string): Promise<EndpointRecord | null>;
  /** Refused (`conflict`) while a previous secret is still valid at `now`. */
  abstract rotateSecret(
    shopId: string,
    id: string,
    next: { secretSealed: string; previousExpiresAt: Date },
    now: Date,
  ): Promise<ConditionalOutcome>;
  /** Erases the previous secret; `conflict` when there is none. */
  abstract expirePreviousSecret(
    shopId: string,
    id: string,
    now: Date,
  ): Promise<ConditionalOutcome>;
  /** `SET failingSince = :at WHERE failingSince IS NULL`; race-safe, returns the window start now in force. */
  abstract markFailing(id: string, at: Date): Promise<Date | null>;
  /** Clears the failure window. */
  abstract markHealthy(id: string): Promise<void>;
  /** Auto-disable: `WHERE status = 'enabled' AND failingSince <= :cutoff`; null when already disabled or recovered. */
  abstract disableIfFailingSince(
    id: string,
    cutoff: Date,
    now: Date,
  ): Promise<EndpointRecord | null>;
  abstract findFailingBefore(
    cutoff: Date,
    limit: number,
  ): Promise<{ id: string; shopId: string }[]>;
  /** Shop deleted: up to `limit` endpoints per call (and their counter); returns the number removed. */
  abstract deleteForShop(shopId: string, limit: number): Promise<string[]>;
}

// ---------------------------------------------------------------- address guard

export type AddressVerdict =
  { ok: true } | { ok: false; reason: EndpointUrlRejectionReason };

/**
 * Save-time check of an endpoint address (FR-003): every address its name resolves to must be public. The syntactic rules
 * are `domain/webhook-url.ts`; this is the part that looks the name up. Never throws for a rejected address.
 */
export abstract class AddressGuard {
  abstract check(url: string): Promise<AddressVerdict>;
}

// ---------------------------------------------------------------- history

export type HistoryFacet =
  | 'created'
  | 'url'
  | 'events'
  | 'api_version'
  | 'status'
  | 'secret_rotated'
  | 'previous_secret_expired'
  | 'deleted';

export interface HistoryEntry {
  endpointId: string;
  shopId: string;
  facet: HistoryFacet;
  /** Never a secret; URL facets carry the host only. */
  fromValue: string | null;
  toValue: string | null;
  actorId: string | null;
  at: Date;
}

export abstract class EndpointHistory {
  abstract append(entries: HistoryEntry[]): Promise<void>;
  abstract listForEndpoint(
    shopId: string,
    endpointId: string,
    limit: number,
  ): Promise<HistoryEntry[]>;
  abstract deleteForShop(shopId: string, limit: number): Promise<number>;
  /** Retention purge (400 days). */
  abstract deleteOlderThan(cutoff: Date, limit: number): Promise<number>;
}

// ---------------------------------------------------------------- delivery log (delivery state and attempts)

export type DeliveryKind = 'event' | 'replay' | 'ping';
export type DeliveryState = WebhookDeliveryStateName;
export type CancelReason =
  'endpoint_disabled' | 'endpoint_deleted' | 'shop_deleted';
export type FailureReason = 'payload_too_large';

/** Closed list of attempt `error` values (S54 vocabulary plus `payload_too_large`). */
export type AttemptError =
  | 'blocked_address'
  | 'unresolvable'
  | 'invalid_url'
  | 'redirect_refused'
  | 'redirected_host'
  | 'too_many_redirects'
  | 'unsupported_content_type'
  | 'timeout'
  | 'tls_error'
  | 'network_error'
  | 'payload_too_large';

export interface DeliveryRecord {
  endpointId: string;
  shopId: string;
  eventId: string;
  deliveryId: string;
  type: WebhookEventTypeName;
  kind: DeliveryKind;
  state: DeliveryState;
  /** The number the next attempt will carry (starts at 1). */
  attempt: number;
  nextAttemptAt: Date | null;
  claimedAt: Date | null;
  cancelReason?: CancelReason;
  failureReason?: FailureReason;
  /** The exact signed bytes (<= 256 KiB). */
  body: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * The key a delivery has in the log. An event delivery is keyed by the event id (a second create for the same endpoint and
 * event is the same delivery); a replay re-sends the same event id and gets its own record, keyed by event and delivery id
 * so it can never overwrite the original. A ping has a fresh event id of its own.
 */
export const deliveryKey = (d: {
  kind: DeliveryKind;
  eventId: string;
  deliveryId: string;
}): string =>
  d.kind === 'replay' ? `${d.eventId}#replay#${d.deliveryId}` : d.eventId;

export interface AttemptRecord {
  endpointId: string;
  deliveryId: string;
  eventId: string;
  type: WebhookEventTypeName;
  attemptId: string;
  attempt: number;
  startedAt: Date;
  durationMs: number;
  status: number | null;
  ok: boolean;
  error?: AttemptError;
  /** At most 1 KiB of the receiver's answer. */
  responseSnippet?: string;
  replay: boolean;
  expiresAt: Date;
}

export type DeliveryTransition = Pick<DeliveryRecord, 'state' | 'attempt'> & {
  nextAttemptAt?: Date | null;
  cancelReason?: CancelReason;
  failureReason?: FailureReason;
};

export type ClaimOutcome =
  | { claimed: true; delivery: DeliveryRecord }
  | {
      claimed: false;
      reason: 'missing' | 'delivered' | 'terminal' | 'in_flight' | 'stale';
    };

/**
 * Methods that take `eventId` address a delivery by its log key (`deliveryKey`): the event id for an event or a ping, the
 * replay key for a replay. Reading an event for the dashboard passes the plain event id and so always reaches the
 * original delivery.
 */
export abstract class DeliveryLog {
  /** Conditional put on `(endpointId, eventId)`: a second create of the same pair is `exists`, never an overwrite. */
  abstract createDelivery(
    delivery: DeliveryRecord,
  ): Promise<'created' | 'exists'>;
  /** Expired items (`expiresAt <= now`) are never returned, whether or not they are physically removed. */
  abstract getDelivery(
    endpointId: string,
    eventId: string,
    now: Date,
  ): Promise<DeliveryRecord | null>;
  /**
   * Atomic per-attempt claim: `state IN (queued, retry_scheduled) AND attempt = :attempt`, or `delivering` with a claim
   * older than `staleAfterMs` (an in-doubt attempt after a crash consumes its number).
   */
  abstract claim(
    endpointId: string,
    eventId: string,
    attempt: number,
    now: Date,
    staleAfterMs: number,
  ): Promise<ClaimOutcome>;
  /** One transactional write: the attempt item and the delivery's next state. A failure rejects, so the message is redriven. */
  abstract recordAttempt(
    attempt: AttemptRecord,
    next: DeliveryTransition,
  ): Promise<void>;
  /**
   * Gives a claimed attempt back without recording one (breaker open): `delivering -> retry_scheduled` with the same
   * attempt number. Conditional on `(delivering, attempt)`, so a superseded worker changes nothing.
   */
  abstract release(
    endpointId: string,
    eventId: string,
    attempt: number,
    nextAttemptAt: Date,
  ): Promise<void>;
  /** Marks a delivery cancelled without an attempt (disabled or deleted endpoint). */
  abstract cancel(
    endpointId: string,
    eventId: string,
    reason: CancelReason,
  ): Promise<void>;
  /**
   * Cancels every delivery of the endpoint that has not reached a terminal state (disabled endpoint); returns the
   * number cancelled. Idempotent: a delivery that is terminal, or was cancelled by another caller first, is not counted.
   */
  abstract cancelPending(
    endpointId: string,
    reason: CancelReason,
  ): Promise<number>;
  abstract listAttempts(
    endpointId: string,
    query: {
      eventId?: string;
      ok?: boolean;
      limit: number;
      after?: { startedAt: Date; attemptId: string };
    },
    now: Date,
  ): Promise<AttemptRecord[]>;
  abstract countAttempts(
    endpointId: string,
    eventId: string,
    now: Date,
  ): Promise<number>;
  /** Deletes the endpoint's items in batches; returns the number removed. */
  abstract deleteForEndpoint(
    endpointId: string,
    limit: number,
  ): Promise<number>;
}

// ---------------------------------------------------------------- breaker

/** Disposable state per endpoint. Every method resolves: a store error is answered as a closed breaker and counted. */
export abstract class BreakerStore {
  abstract get(endpointId: string): Promise<BreakerState>;
  /** Dashboard view: true while the circuit is open or probing (not closed) at `nowMs`. */
  abstract isOpen(endpointId: string, nowMs: number): Promise<boolean>;
  /** Wins the single probe lease (`SET NX PX`); false when another delivery holds it. */
  abstract acquireProbe(endpointId: string, leaseMs: number): Promise<boolean>;
  abstract recordFailure(
    endpointId: string,
    now: number,
  ): Promise<BreakerState>;
  abstract recordSuccess(endpointId: string): Promise<void>;
  abstract reset(endpointId: string): Promise<void>;
}

// ---------------------------------------------------------------- queue

/** The queue message: no body, no secret. */
export interface DeliveryMessage {
  endpointId: string;
  eventId: string;
  deliveryId: string;
  kind: DeliveryKind;
  attempt: number;
  /**
   * Set only on messages a delayed retry puts back into the lane: the instant they were scheduled for. It is part of the
   * deduplication id, so a delivery re-scheduled with an unchanged attempt number (breaker open) is not dropped as a
   * repeat of the message queued earlier.
   */
  scheduledFor?: string;
}

export abstract class DeliveryQueue {
  /** FIFO lane: group = endpoint id, deduplication id = endpoint, event, kind, attempt (and `scheduledFor`). */
  abstract enqueue(message: DeliveryMessage): Promise<void>;
  abstract enqueueMany(messages: DeliveryMessage[]): Promise<void>;
  /** Delayed retry outside the lane (job `webhooks.retry` with an idempotency key). */
  abstract scheduleRetry(message: DeliveryMessage, runAt: Date): Promise<void>;
}

// ---------------------------------------------------------------- outbound http

export interface OutboundRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Overall deadline of the attempt. */
  timeoutMs: number;
  /** Bytes of the answer that are read. */
  maxResponseBytes: number;
}

export type OutboundResult =
  | {
      kind: 'response';
      status: number;
      snippet: string;
      retryAfterSec?: number;
      durationMs: number;
    }
  | { kind: 'failure'; error: AttemptError; durationMs: number };

export abstract class OutboundHttp {
  /** Never throws for a receiver or network problem: every failure is a typed result. */
  abstract post(request: OutboundRequest): Promise<OutboundResult>;
}

// ---------------------------------------------------------------- routing receipts

export type ReceiptClaim =
  /** First handler of this source event (`attempts` > 1: an earlier handling failed and this is its retry). */
  | { outcome: 'claimed'; attempts: number }
  | { outcome: 'done' }
  /** Another handler holds it right now. */
  | { outcome: 'in_progress' };

/** One receipt per `(consumer group, source event id)`; the inbox (`infrastructure:inbox`) behind it. */
export abstract class RoutingReceipts {
  abstract claim(group: string, sourceEventId: string): Promise<ReceiptClaim>;
  /** Recorded only after every endpoint message of the event was accepted by the queue. */
  abstract complete(group: string, sourceEventId: string): Promise<void>;
  /** The handling failed: the next claim of the same event takes it over at once. Never throws. */
  abstract fail(group: string, sourceEventId: string): Promise<void>;
}

// ---------------------------------------------------------------- random

/** Jitter source, injected so the schedule is testable at random 0 and 1. */
export abstract class RandomSource {
  /** Uniform in [0, 1]. */
  abstract next(): number;
}
