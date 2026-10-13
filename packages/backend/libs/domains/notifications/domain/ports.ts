import type { NotificationRealtimeEvent } from '@marketplace-sandbox/contracts';
import type { Channel } from './catalog';
import type { CallbackMessage } from './callbacks';
import type { SendResult } from './provider-ports';
import type {
  DeadLetterReason,
  DeliveryLine,
  DeliveryMessage,
  DeliveryStatus,
  SuppressionReason,
} from './types';

export { Clock, CLOCK } from '@app/common/core/clock';

/**
 * Ports of notifications (specs/domains/S28-notifications/data-model.md "Ports"). `domain/` and `application/` know
 * only these interfaces; `infra/` implements them over Postgres, the wide-column store, Redis, SQS and the exported
 * services of other domains. Nothing here imports Nest, Sequelize, Redis or reads the wall clock: time arrives as an
 * argument or through `Clock`.
 */

// ---- Postgres (owned tables) ---------------------------------------------------------------------------------------

export interface StoredSettings {
  userId: string;
  timezone: string;
  locale: string;
  quietStart: string | null;
  quietEnd: string | null;
  phone: string | null;
  phoneVerifiedAt: Date | null;
  updatedAt: Date;
}

/** Only the keys present are written. Writing a different `phone` clears `phoneVerifiedAt` in the same statement. */
export interface SettingsPatch {
  timezone?: string;
  locale?: string;
  quietStart?: string | null;
  quietEnd?: string | null;
  phone?: string | null;
}

export interface SettingsRepository {
  find(userId: string): Promise<StoredSettings | null>;
  findMany(userIds: string[]): Promise<Map<string, StoredSettings>>;
  /** Upsert; returns the row after the write. */
  update(
    userId: string,
    patch: SettingsPatch,
    now: Date,
  ): Promise<StoredSettings>;
  /** Marks the stored phone verified; false when the phone changed meanwhile (`phone` must still equal `phone`). */
  markPhoneVerified(userId: string, phone: string, now: Date): Promise<boolean>;
}

export interface PreferenceRepository {
  /** `${category}:${channel}` -> explicit choice. */
  overrides(userId: string): Promise<Record<string, boolean>>;
  overridesMany(
    userIds: string[],
  ): Promise<Map<string, Record<string, boolean>>>;
  /** Idempotent upsert of one cell. */
  set(
    userId: string,
    category: string,
    channel: Channel,
    enabled: boolean,
    now: Date,
  ): Promise<void>;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  platform: 'ios' | 'android' | 'web';
  token: string;
  lastSeenAt: Date;
}

export interface DeviceRepository {
  list(userId: string): Promise<DeviceRecord[]>;
  listMany(userIds: string[]): Promise<Map<string, DeviceRecord[]>>;
  /**
   * Upsert on the token (a token belongs to the latest registering user) and evict the oldest `lastSeenAt` beyond
   * `cap` for that user in the same transaction. `created` is false for a known token; `previousUserId` is the other
   * user the token belonged to before this call, if any (their cached view must be invalidated).
   */
  register(
    input: {
      userId: string;
      token: string;
      platform: DeviceRecord['platform'];
    },
    cap: number,
    now: Date,
  ): Promise<{
    device: DeviceRecord;
    created: boolean;
    previousUserId: string | null;
  }>;
  /** `WHERE id AND userId`; false when no row matched (also another user's id). */
  remove(userId: string, deviceId: string): Promise<boolean>;
  /** A dead push token reported by the provider; returns the user it belonged to. */
  removeByToken(token: string): Promise<string | null>;
}

export interface SuppressionRepository {
  /** Addresses are normalized by the caller (e-mail trimmed and lower-cased, phone E.164). */
  suppressedAmong(channel: Channel, addresses: string[]): Promise<Set<string>>;
  /** Idempotent; true when the row is new. */
  add(
    channel: Channel,
    address: string,
    reason: SuppressionReason,
    now: Date,
  ): Promise<boolean>;
}

// ---- wide-column store ----------------------------------------------------------------------------------------------

export interface InboxItemRecord {
  /** Deterministic from the dedupe identity. */
  id: string;
  userId: string;
  type: string;
  category: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  /** When the fact happened; the sort key, encoded in the time-UUID `id` (the API's `createdAt`). */
  eventTime: Date;
  /** When the item reached the inbox; compared with the mark-all watermark. Null on rows written before S28 (use `eventTime`). */
  arrivedAt: Date | null;
}

export interface InboxPosition {
  eventTime: Date;
  id: string;
}

/** The retention window of a read: items with an event time in `[from, to]` (`from` = now - 180 days, `to` = now). */
export interface InboxRange {
  from: Date;
  to: Date;
}

export interface InboxStore {
  /** `INSERT ... IF NOT EXISTS`; true when this call created the item. The id is a time-UUID derived from the identity. */
  insertIfAbsent(item: InboxItemRecord): Promise<boolean>;
  /** Newest first by (eventTime, id), strictly after `after`, inside `range`; at most `limit` rows. `read` is the row's own flag. */
  page(
    userId: string,
    limit: number,
    after: InboxPosition | null,
    range: InboxRange,
  ): Promise<InboxItemRecord[]>;
  /** The caller's own items among `ids` (foreign, unknown and out-of-range ids are absent). */
  findOwned(
    userId: string,
    ids: string[],
    range: InboxRange,
  ): Promise<InboxItemRecord[]>;
  /** `UPDATE ... SET read = true IF read = false`; true when this call flipped it. */
  markRead(userId: string, item: InboxPosition): Promise<boolean>;
  /** Mark-all watermark: items that arrived at or before it count as read. */
  readAllBefore(userId: string): Promise<Date | null>;
  setReadAllBefore(userId: string, at: Date): Promise<void>;
  /** Unread items (row flag and watermark both applied) counted from the inbox itself, stopping at `bound`. */
  countUnread(
    userId: string,
    bound: number,
    range: InboxRange,
  ): Promise<number>;
}

export interface DeliveryRecord {
  deliveryId: string;
  userId: string | null;
  channel: Channel;
  type: string;
  line: DeliveryLine;
}

export interface DeliveryUpdate {
  status: DeliveryStatus;
  provider?: string;
  providerMessageId?: string;
  /** Never a body, address or token. */
  detail?: string;
  failover?: boolean;
  at: Date;
}

export interface DeliverySummary extends DeliveryRecord {
  status: DeliveryStatus;
  provider: string | null;
  providerMessageId: string | null;
  updatedAt: Date;
}

export interface DeliveryTimelineStore {
  /** Creates the summary row in `queued` (idempotent per delivery id) and the first timeline row. */
  begin(record: DeliveryRecord, at: Date): Promise<void>;
  /**
   * Appends a timeline row and moves the summary only forward by rank (`IF rank < :rank`). Returns the status that
   * stands afterwards; a failure here never fails or repeats a send (the caller logs it).
   */
  advance(deliveryId: string, update: DeliveryUpdate): Promise<DeliveryStatus>;
  find(deliveryId: string): Promise<DeliverySummary | null>;
  /** 30-day lookup written when a provider accepts a message. */
  linkProvider(
    provider: string,
    providerMessageId: string,
    deliveryId: string,
  ): Promise<void>;
  findByProvider(
    provider: string,
    providerMessageId: string,
  ): Promise<string | null>;
}

// ---- Redis ----------------------------------------------------------------------------------------------------------

export interface CounterStore {
  /** The cached unread count, or null when the key is absent (rebuild from the inbox). */
  get(userId: string): Promise<number | null>;
  increment(userId: string): Promise<void>;
  decrement(userId: string, by: number): Promise<void>;
  set(userId: string, value: number): Promise<void>;
  /** `unread:dirty`: written before an inbox insert so a crash before the increment is repaired by the sweep. */
  markDirty(userId: string, at: Date): Promise<void>;
  clearDirty(userId: string): Promise<void>;
  /** Users marked dirty at or before `before`, oldest first. */
  dirtyBefore(before: Date, limit: number): Promise<string[]>;
}

export type CapDecision = 'admit' | 'reject';

export interface CapStore {
  /**
   * One atomic step: the first decision for `deliveryId` is final (replays get it back); otherwise admit when fewer
   * than `limit` deliveries were admitted in the rolling window ending at `now`. Throws when the store is down (the
   * caller fails closed for marketing).
   */
  admit(input: {
    userId: string;
    channel: Channel;
    deliveryId: string;
    limit: number;
    windowMs: number;
    now: Date;
  }): Promise<CapDecision>;
}

export interface DedupeStore {
  /** `done:<identity>`: a shortcut only, never the guard of exactly-once. */
  isDone(identity: string): Promise<boolean>;
  markDone(identity: string): Promise<void>;
}

export interface VersionGuardStore {
  /**
   * Compare-and-set of the highest notified version of `family:aggregateId`: true (and the maximum stored) when
   * `version` is not lower than the stored one or none is stored; false for a lower version (a stale event). An equal
   * version passes: a redelivery is stopped by the idempotent steps, not by the guard.
   */
  admit(family: string, aggregateId: string, version: number): Promise<boolean>;
}

export interface ClaimStore {
  /** `SET claim:<deliveryId> NX PX ttl`; true when this worker holds the claim. */
  claim(deliveryId: string, workerId: string, ttlMs: number): Promise<boolean>;
  release(deliveryId: string, workerId: string): Promise<void>;
  /** `sent:<deliveryId>` -> provider message id; a delivery with a marker is never handed to a provider again. */
  sentMarker(deliveryId: string): Promise<string | null>;
  markSent(deliveryId: string, providerMessageId: string): Promise<void>;
}

export interface OtpStore {
  /** Replaces any pending code; `codeMac` is an HMAC of the code, never the code. */
  put(userId: string, codeMac: string, ttlSeconds: number): Promise<void>;
  get(userId: string): Promise<string | null>;
  /** Failed attempts so far, after counting this one. */
  failAttempt(userId: string, ttlSeconds: number): Promise<number>;
  lock(userId: string, ttlSeconds: number): Promise<void>;
  /** Seconds left of the lock, or 0. */
  lockedFor(userId: string): Promise<number>;
  clear(userId: string): Promise<void>;
}

// ---- other domains (R1 services) and runtime edges --------------------------------------------------------------------

export interface DirectoryUser {
  userId: string;
  email: string | null;
}

export interface RecipientDirectory {
  /** Batched (at most 500 ids per call inside); unknown ids are absent. */
  users(userIds: string[]): Promise<Map<string, DirectoryUser>>;
  /** OWNER members of each shop, batched; a shop without owners maps to an empty list. */
  shopOwners(shopIds: string[]): Promise<Map<string, string[]>>;
}

export interface FollowerPage {
  userIds: string[];
  nextCursor: string | null;
}

export interface FollowerAudience {
  /** Pages of at most 1,000 followers of an account. Fails closed until community exports the query (R-5). */
  followers(
    accountId: string,
    limit: number,
    cursor: string | null,
  ): Promise<FollowerPage>;
}

export interface RealtimeNotifier {
  /** Event `notification` on `user:<userId>`; best effort, the caller counts a failure and goes on. */
  notify(userId: string, event: NotificationRealtimeEvent): Promise<void>;
}

export interface LineEnqueueOptions {
  /** Queue delay, at most 900 seconds. */
  delaySeconds?: number;
  /** Deduplication id: the delivery id. */
  dedupeId: string;
}

export interface DeliveryLineProducer {
  enqueue(
    line: DeliveryLine,
    channel: DeliveryMessage['channel'],
    message: DeliveryMessage,
    options: LineEnqueueOptions,
  ): Promise<void>;
}

export interface CallbackQueue {
  /**
   * Durable accept: resolves only when the queue has the message. `eventId` is the provider's own event identity (SNS
   * MessageId, Twilio MessageSid + MessageStatus); the worker deduplicates on it. `attempt` and `delaySeconds` are for
   * the worker's own re-queue of a callback that raced our timeline write.
   */
  accept(
    callback: CallbackMessage,
    options?: { delaySeconds?: number; attempt?: number },
  ): Promise<void>;
}

export type SendBudgetDecision =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface SendBudget {
  /**
   * Token-bucket take for the provider budget of `channel` and `line`. A limiter outage is decided inside the adapter:
   * transactional fails open (`allowed`), marketing fails closed (`retryAfterSeconds: 60`).
   */
  take(channel: Channel, line: DeliveryLine): Promise<SendBudgetDecision>;
}

export interface WakeScheduler {
  /** One job `notifications.wake-delivery` per delivery (idempotency key = delivery id). */
  schedule(deliveryId: string, runAt: Date): Promise<void>;
  cancel(deliveryId: string): Promise<void>;
}

/** A delivery held for quiet hours beyond the queue delay: everything the wake job needs, since its payload is the delivery id only. */
export interface HeldDelivery {
  line: DeliveryLine;
  message: DeliveryMessage;
  /** After this instant the delivery is moot (maximum age, FR-006). */
  staleAt: Date;
  wakeAt: Date;
}

export interface HeldDeliveryStore {
  /** Idempotent per delivery id; kept `ttlSeconds` (the wait plus a margin). */
  put(
    deliveryId: string,
    held: HeldDelivery,
    ttlSeconds: number,
  ): Promise<void>;
  get(deliveryId: string): Promise<HeldDelivery | null>;
  delete(deliveryId: string): Promise<void>;
}

export interface ProviderChain {
  /**
   * Walks the ordered providers of the channel: skips an open breaker, fails over on a transient error or the 10 s
   * timeout (`failover: true` on the result), stops on a permanent error (`PermanentDeliveryError`).
   */
  send(message: DeliveryMessage): Promise<SendResult>;
  /** The first provider of the chain: the subject of the channel's send budget. */
  readonly primary: string;
}

/** The e-mail chain of one-off account mails (password reset), which go straight out without a queue. */
export const TRANSACTIONAL_MAIL_CHAIN = Symbol(
  'NOTIFICATIONS_TRANSACTIONAL_MAIL_CHAIN',
);

/** The chain of each external channel. */
export const PROVIDER_CHAINS = Symbol('NOTIFICATIONS_PROVIDER_CHAINS');
export type ProviderChains = Record<DeliveryMessage['channel'], ProviderChain>;

/** A message S28 gave up on. The record names it and says why; it never holds a payload, body, address or token. */
export interface DeadLetterRecord {
  /** Source family (`orders`, `identity`, ...) or the single-consumer queue name. */
  source: string;
  reason: DeadLetterReason;
  /** The event id, or the queue message id for a single-consumer message. */
  eventId: string;
  type?: string;
  at: Date;
}

export interface DeadLetterSink {
  record(letter: DeadLetterRecord): Promise<void>;
  /** Newest first; for operators and specs. */
  recent(limit: number): Promise<DeadLetterRecord[]>;
}

// ---- injection tokens --------------------------------------------------------------------------------------------------

export const PREFERENCE_REPOSITORY = Symbol(
  'NOTIFICATIONS_PREFERENCE_REPOSITORY',
);
export const SETTINGS_REPOSITORY = Symbol('NOTIFICATIONS_SETTINGS_REPOSITORY');
export const DEVICE_REPOSITORY = Symbol('NOTIFICATIONS_DEVICE_REPOSITORY');
export const SUPPRESSION_REPOSITORY = Symbol(
  'NOTIFICATIONS_SUPPRESSION_REPOSITORY',
);
export const INBOX_STORE = Symbol('NOTIFICATIONS_INBOX_STORE');
export const DELIVERY_TIMELINE_STORE = Symbol(
  'NOTIFICATIONS_DELIVERY_TIMELINE_STORE',
);
export const COUNTER_STORE = Symbol('NOTIFICATIONS_COUNTER_STORE');
export const CAP_STORE = Symbol('NOTIFICATIONS_CAP_STORE');
export const DEDUPE_STORE = Symbol('NOTIFICATIONS_DEDUPE_STORE');
export const VERSION_GUARD_STORE = Symbol('NOTIFICATIONS_VERSION_GUARD_STORE');
export const CLAIM_STORE = Symbol('NOTIFICATIONS_CLAIM_STORE');
export const OTP_STORE = Symbol('NOTIFICATIONS_OTP_STORE');
export const RECIPIENT_DIRECTORY = Symbol('NOTIFICATIONS_RECIPIENT_DIRECTORY');
export const FOLLOWER_AUDIENCE = Symbol('NOTIFICATIONS_FOLLOWER_AUDIENCE');
export const REALTIME_NOTIFIER = Symbol('NOTIFICATIONS_REALTIME_NOTIFIER');
export const DELIVERY_LINE_PRODUCER = Symbol(
  'NOTIFICATIONS_DELIVERY_LINE_PRODUCER',
);
export const CALLBACK_QUEUE = Symbol('NOTIFICATIONS_CALLBACK_QUEUE');
export const SEND_BUDGET = Symbol('NOTIFICATIONS_SEND_BUDGET');
export const WAKE_SCHEDULER = Symbol('NOTIFICATIONS_WAKE_SCHEDULER');
export const HELD_DELIVERY_STORE = Symbol('NOTIFICATIONS_HELD_DELIVERY_STORE');
export const PROVIDER_CHAIN = Symbol('NOTIFICATIONS_PROVIDER_CHAIN');
export const DEAD_LETTER_SINK = Symbol('NOTIFICATIONS_DEAD_LETTER_SINK');
