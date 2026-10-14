import type {
  ChatChannelMemberRole,
  ChatChannelMemberStatus,
} from './chat.constants';

/**
 * Ports of `chat` (S24 contracts/services.md; D-6): `application/` depends on these only, `infra/` implements them
 * with SQL, Redis and the platform services. Time is never read here or in `application/` except through `CLOCK`
 * (G-36): `Clock` is the shape of that token's value.
 */
export interface Clock {
  now(): Date;
}

export const PORTS = {
  ChannelRepository: Symbol('ChatChannelRepository'),
  MembershipRepository: Symbol('ChatMembershipRepository'),
  SyncRepository: Symbol('ChatSyncRepository'),
  PartitionRepository: Symbol('ChatPartitionRepository'),
  RealtimeHub: Symbol('ChatRealtimeHub'),
  EscalationOutbox: Symbol('ChatEscalationOutbox'),
  TicketSigner: Symbol('ChatTicketSigner'),
  ShopProvisioner: Symbol('ChatShopProvisioner'),
  PurgeRepository: Symbol('ChatPurgeRepository'),
  ShopBackfillRepository: Symbol('ChatShopBackfillRepository'),
  RecentWindow: Symbol('ChatRecentWindow'),
  MessageRepository: Symbol('ChatMessageRepository'),
  ReadStateRepository: Symbol('ChatReadStateRepository'),
  PresenceStore: Symbol('ChatPresenceStore'),
  LiveBusPort: Symbol('ChatLiveBusPort'),
  CoalescingSlot: Symbol('ChatCoalescingSlot'),
  EscalationFactsPort: Symbol('ChatEscalationFactsPort'),
  ProductLookup: Symbol('ChatProductLookup'),
  ShopAuthority: Symbol('ChatShopAuthority'),
  PresenceReader: Symbol('ChatPresenceReader'),
} as const;

export interface ChannelRecord {
  id: string;
  productId: string;
  shopId: string;
  sellerId: string;
  title: string;
  isArchived: boolean;
  archivedAt: Date | null;
  lastSeq: number;
  activeMemberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemberRecord {
  channelId: string;
  userId: string;
  role: ChatChannelMemberRole;
  status: ChatChannelMemberStatus;
  mutedUntil: Date | null;
  lastReadSeq: number;
}

export interface MessageRecord {
  id: string;
  channelId: string;
  seq: number;
  authorId: string;
  body: string;
  replyToId: string | null;
  clientMessageId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface ChannelRepository {
  /** Creates the channel and its OWNER member in one transaction; null when the product already has a channel. */
  createIfAbsent(input: {
    productId: string;
    shopId: string;
    sellerId: string;
    title: string;
    ownerUserId: string;
    now: Date;
  }): Promise<ChannelRecord | null>;
  /** Readable only by an active member (the principal is in the predicate, III.4). */
  findForMember(
    channelId: string,
    userId: string,
  ): Promise<{ channel: ChannelRecord; member: MemberRecord } | null>;
  /** Public fields plus the caller's role when they are a member. */
  findByProduct(
    productId: string,
    userId: string,
  ): Promise<{ channel: ChannelRecord; member: MemberRecord | null } | null>;
  findById(channelId: string): Promise<ChannelRecord | null>;
  /** `UPDATE … WHERE isArchived = :from`; false when the row was not in that state. */
  setArchived(
    channelId: string,
    from: boolean,
    now: Date,
  ): Promise<ChannelRecord | null>;
  setTitle(
    channelId: string,
    title: string,
    now: Date,
  ): Promise<ChannelRecord | null>;
  /**
   * Takes the channel row lock (inside a transaction). Status flips of a member move the channel's member count; a
   * sender holds this lock first and the member row second, so moderators lock in that order too (no deadlock).
   */
  lock(channelId: string): Promise<void>;
  /** Part of the recent-window cache key: a delete changes it in the same transaction as the tombstone. */
  bumpDeleteEpoch(channelId: string): Promise<void>;
}

export type JoinOutcome =
  | { kind: 'joined'; member: MemberRecord }
  | { kind: 'exists'; member: MemberRecord }
  | { kind: 'banned' }
  | { kind: 'archived' }
  | { kind: 'not_found' };

export interface MembershipRepository {
  /** One conditional upsert that never touches role or status of an existing row; diagnosis only picks the error. */
  join(channelId: string, userId: string, now: Date): Promise<JoinOutcome>;
  find(channelId: string, userId: string): Promise<MemberRecord | null>;
  /** Conditional state change; null when the row was not in the `from` state. */
  changeStatus(
    channelId: string,
    userId: string,
    from: ChatChannelMemberStatus,
    to: ChatChannelMemberStatus,
  ): Promise<boolean>;
  changeRole(
    channelId: string,
    userId: string,
    from: ChatChannelMemberRole,
    to: ChatChannelMemberRole,
  ): Promise<boolean>;
  setMute(
    channelId: string,
    userId: string,
    mutedUntil: Date,
    now: Date,
  ): Promise<boolean>;
  /** Clears an active mute (`mutedUntil` in the future); false when the member is not muted. */
  clearMute(channelId: string, userId: string, now: Date): Promise<boolean>;
  /** Active members other than `exceptUserId`, at most `limit`. */
  activeMembers(
    channelId: string,
    exceptUserId: string,
    limit: number,
  ): Promise<string[]>;
  /** Users among `userIds` who share an active channel with `userId` (the caller included). */
  coMembers(userId: string, userIds: string[]): Promise<string[]>;
  /** The user's most recently active channels (active memberships), newest message first. */
  recentChannels(
    userId: string,
    limit: number,
  ): Promise<Array<{ channelId: string; activeMemberCount: number }>>;
}

export type SendRefusal =
  'not_found' | 'banned' | 'muted' | 'archived' | 'reply_target_invalid';

export type InsertOutcome =
  | { kind: 'created'; message: MessageRecord }
  | { kind: 'replay'; message: MessageRecord; sameContent: boolean }
  | { kind: 'refused'; reason: SendRefusal; mutedUntil?: Date };

export interface MessageRepository {
  insertIfAllowed(input: {
    channelId: string;
    authorId: string;
    clientMessageId: string;
    body: string;
    replyToId: string | null;
    now: Date;
  }): Promise<InsertOutcome>;
  listSince(
    channelId: string,
    afterSeq: number,
    toSeq: number,
  ): Promise<MessageRecord[]>;
  listPage(
    channelId: string,
    beforeSeq: number | null,
    limit: number,
  ): Promise<MessageRecord[]>;
  /** Author and state of a message of the channel, or null when there is none (unknown, or another channel's). */
  authorOf(
    channelId: string,
    messageId: string,
  ): Promise<{ authorId: string; deleted: boolean } | null>;
  /** True when this call changed the row (a repeat changes nothing). */
  softDelete(
    channelId: string,
    messageId: string,
    deletedBy: string,
    now: Date,
  ): Promise<'deleted' | 'already' | 'missing'>;
}

export interface ReadableChannel {
  id: string;
  lastSeq: number;
  /** Incremented in the transaction of a message delete: part of the recent-window cache key. */
  deleteEpoch: string;
}

export interface SyncWindow {
  channelId: string;
  afterSeq: number;
  toSeq: number;
}

/** Reads behind `POST /chat/sync`: three statements for up to 50 channels, whatever the number of channels. */
export interface SyncRepository {
  /** The membership filter: only channels where `userId` is an active member come back. */
  readable(userId: string, channelIds: string[]): Promise<ReadableChannel[]>;
  /** The index range of every window, then the bodies of those messages (tombstones included, ascending by seq). */
  loadWindows(windows: SyncWindow[]): Promise<Map<string, MessageRecord[]>>;
}

/** The tail of a channel keyed by what makes it stale: last sequence and delete epoch. */
export interface RecentWindow {
  tails(
    items: ReadableChannel[],
    load: (missing: ReadableChannel[]) => Promise<Map<string, MessageRecord[]>>,
  ): Promise<Map<string, MessageRecord[]>>;
}

/** Monthly partitions of `ChatMessage` (S24 FR-024). */
export interface PartitionRepository {
  /** Serialises overlapping runs: a transaction-level advisory lock, so the second run finds the partitions. */
  lock(): Promise<void>;
  /** Months (`YYYY-MM`, UTC) that already have a partition. */
  existing(): Promise<Set<string>>;
  /** Creation time of the oldest row parked in the default partition (a missing month), or null. */
  oldestDefault(): Promise<Date | null>;
  defaultRows(): Promise<number>;
  /** Creates the month's partition with its indexes, moving any rows parked in the default partition into it. */
  create(month: string): Promise<{ moved: number }>;
}

export interface ReadPosition {
  lastReadSeq: number;
  lastSeq: number;
  activeMemberCount: number;
  /** False when the call changed nothing (stale or equal request). */
  advanced: boolean;
}

export interface UnreadEntry {
  channelId: string;
  unread: number;
  lastSeq: number;
  /** The keyset position of this row: `activity::text`, see `UnreadCursor`. */
  activityAt: string;
}

export interface ReadStateRepository {
  /**
   * `LEAST(GREATEST(lastReadSeq,:seq), lastSeq)` as one conditional update (monotonic, capped, safe under
   * concurrency); null when the caller is not an active member. Archived channels can still be marked read.
   */
  advance(
    channelId: string,
    userId: string,
    seq: number,
    now: Date,
  ): Promise<ReadPosition | null>;
  /** Active, non-archived channels of the user by most recent activity first; `limit + 1` rows tell whether more remain. */
  unreadPage(
    userId: string,
    limit: number,
    after: { at: string; channelId: string } | null,
  ): Promise<UnreadEntry[]>;
}

/** Live-only events on the realtime hub topic `chat:<channelId>` (receipts, presence); best effort. */
export interface RealtimeHub {
  /** True when the hub took the event. Never throws for a store fault. */
  publish(
    channelId: string,
    type: 'read' | 'presence',
    data: Record<string, unknown>,
  ): Promise<boolean>;
}

/**
 * Ephemeral presence (never the primary database). The store keeps the epoch ms of the last heartbeat; whether that is
 * "online" is decided by the caller against the injected clock (a store TTL runs on wall-clock time and could not be
 * moved by a frozen clock). Every method may throw when the store is unreachable.
 */
export interface PresenceStore {
  /** Atomically records the heartbeat and returns the previous one (the offline → online transition is decided from it). */
  heartbeat(userId: string, now: Date): Promise<{ previous: number | null }>;
  /** One multi-get: epoch ms of the last heartbeat, or null. */
  multiGet(userIds: string[]): Promise<Map<string, number | null>>;
}

export interface PresenceReader {
  isOnline(userId: string): Promise<boolean | 'unknown'>;
}

export interface LiveBusPort {
  publishChannel(
    channelId: string,
    event: Record<string, unknown>,
  ): Promise<void>;
  publishModeration(event: Record<string, unknown>): Promise<void>;
}

/**
 * One escalation per (recipient, channel) per window. The slot is taken as `pending` (short) before the event is
 * appended and confirmed (full window) only after the append succeeded, so a failed append does not cost the
 * recipient their push (R-07, AS-47). Every method throws when the store is unreachable.
 */
export interface CoalescingSlot {
  /** `{token}` when taken; null when a notification is inside its window (pending or confirmed). */
  take(
    recipientId: string,
    channelId: string,
    now: Date,
  ): Promise<{ token: string } | null>;
  confirm(
    recipientId: string,
    channelId: string,
    token: string,
    now: Date,
  ): Promise<void>;
  release(recipientId: string, channelId: string, token: string): Promise<void>;
}

export interface EscalationFacts {
  /** Active member of a channel that is not archived. */
  eligible: boolean;
  /** The message is deleted, or gone altogether. */
  deleted: boolean;
  readSeq: number;
  channelTitle: string;
}

export interface EscalationFactsPort {
  load(input: {
    channelId: string;
    messageId: string;
    recipientId: string;
  }): Promise<EscalationFacts>;
}

export interface Escalation {
  recipientId: string;
  channelId: string;
  channelTitle: string;
  messageId: string;
  seq: number;
  authorId: string;
  preview: string;
  dedupeKey: string;
}

/** Appends `chat.message_escalated` to the outbox in its own transaction (IV.3); a refusal throws. */
export interface EscalationOutbox {
  append(escalation: Escalation, now: Date): Promise<void>;
}

export interface ProductFacts {
  id: string;
  /** Null for a product that predates shops. */
  shopId: string | null;
  title: string;
  status: string;
}

export interface ProductLookup {
  find(productId: string): Promise<(ProductFacts & { shopId: string }) | null>;
  /** One batch (S05 `getProductsByIds`); unknown products are absent from the map. */
  findMany(productIds: string[]): Promise<Map<string, ProductFacts>>;
}

/** S03 `ensureShopsForLegacySellers`: the shop of each seller that has none, provisioned on demand. */
export interface ShopProvisioner {
  ensureForSellers(sellerIds: string[]): Promise<Map<string, string>>;
}

/** Removal of a deleted shop's chats in bounded batches (S24 FR-043). Every call is idempotent. */
export interface PurgeRepository {
  channelIdsOfShop(shopId: string, limit: number): Promise<string[]>;
  /** Deletes up to `limit` messages (and their index rows) of the channel; returns how many it looked at. */
  deleteMessagesBatch(channelId: string, limit: number): Promise<number>;
  deleteMembersBatch(channelId: string, limit: number): Promise<number>;
  deleteChannel(channelId: string): Promise<void>;
}

export interface LegacyChannel {
  id: string;
  productId: string;
  sellerId: string;
}

/** The shop-id backfill of channels created before shops existed (S24 FR-044, R-12). */
export interface ShopBackfillRepository {
  /** Channels without a shop after `afterId` (keyset by id), at most `limit`. */
  unassigned(afterId: string | null, limit: number): Promise<LegacyChannel[]>;
  assign(channelId: string, shopId: string): Promise<boolean>;
  remaining(): Promise<number>;
  /** Validates the "shop required" constraint and makes the column NOT NULL, when no channel is left without one. */
  requireShop(): Promise<boolean>;
}

/** Signs the 60-second credential for the realtime gateway. */
export interface TicketSigner {
  sign(
    userId: string,
    now: Date,
  ): { ticket: string; wsUrl: string; expiresAt: string };
}

export interface ShopAuthority {
  /** True when the user is a member of the shop with `products.write`, asked live every time. */
  canManage(shopId: string, userId: string): Promise<boolean>;
}
