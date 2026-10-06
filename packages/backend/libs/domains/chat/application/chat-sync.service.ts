import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';
import { chatChannelRedisTopic } from '../domain/chat.constants';

export interface SyncedMessage {
  id: string;
  seq: number;
  authorId: string;
  body: string | null;
  replyToId: string | null;
  createdAt: string;
  deleted: boolean;
}

export interface ChannelSync {
  channelId: string;
  messages: SyncedMessage[];
  lastSeq: number;
  hasMore: boolean;
}

const PER_CHANNEL = 200;
const MAX_CHANNELS = 50;
const TAIL = 50;
const PRESENCE_TTL_SEC = 60;
const presenceKey = (userId: string) => `presence:{${userId}}`;
const tailKey = (channelId: string, lastSeq: number) => `chat:tail:${channelId}:${lastSeq}`;

/**
 * Delivery guarantee for chat (10/06 #14): push (Rust WS) is best-effort; the
 * client keeps the highest seq it has per channel and calls sync on every
 * (re)connect. Sequence numbers are gap-free per channel, so "did I miss
 * anything?" is one comparison.
 */
@Injectable()
export class ChatSyncService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly redis: RedisService,
    private readonly cache: CacheService,
    private readonly realtime: RealtimePublisher,
  ) {}

  /**
   * HTTP send (fallback when the WebSocket is down, and for mobile background
   * sends). `clientMessageId` makes retries idempotent: same id → same row,
   * same seq. The new message goes on the Rust bus with the exact envelope
   * Rust uses, so WS clients see it like any other message.
   */
  async send(channelId: string, userId: string, body: string, clientMessageId: string, replyToId?: string) {
    await this.assertCanPost(channelId, userId);
    const [inserted] = await this.sequelize.query<SyncedMessage & { created: boolean }>(
      `INSERT INTO "ChatMessage" (id, "channelId", "authorId", body, "replyToId", "clientMessageId", "createdAt")
       VALUES (uuidv7(), :channelId, :userId, :body, :replyToId, :clientMessageId, now())
       ON CONFLICT ("channelId", "clientMessageId") WHERE "clientMessageId" IS NOT NULL DO NOTHING
       RETURNING id, seq::int AS seq, "authorId", body, "replyToId", "createdAt", false AS deleted, true AS created`,
      { type: QueryTypes.SELECT, replacements: { channelId, userId, body, replyToId: replyToId ?? null, clientMessageId } },
    );
    if (!inserted) {
      const [existing] = await this.sequelize.query<SyncedMessage>(
        `SELECT id, seq::int AS seq, "authorId", body, "replyToId", "createdAt", "deletedAt" IS NOT NULL AS deleted
         FROM "ChatMessage" WHERE "channelId" = :channelId AND "clientMessageId" = :clientMessageId`,
        { type: QueryTypes.SELECT, replacements: { channelId, clientMessageId } },
      );
      if (existing.authorId !== userId) throw new ForbiddenException(); // someone else's client id: don't leak their message
      return { message: existing, duplicate: true };
    }
    const { created: _created, ...message } = inserted;
    await this.redis.client.publish(
      chatChannelRedisTopic(channelId),
      JSON.stringify({ type: 'message', channelId, message: { id: message.id, channelId, authorId: userId, body, replyToId: replyToId ?? null, createdAt: message.createdAt } }),
    );
    return { message, duplicate: false };
  }

  /**
   * `cursors` = { channelId: lastSeqTheClientHas }. One round trip for up to
   * 50 channels: membership filter + LATERAL "seq > since LIMIT 201" per
   * channel on the (channelId, seq) unique index. Channels whose gap is within
   * the last 50 messages are served from a tail cache whose key includes
   * lastSeq - a new message changes the key, so there's nothing to invalidate
   * (a reconnect storm after a gateway deploy hits Redis, not Postgres).
   */
  async sync(userId: string, cursors: Record<string, number>): Promise<ChannelSync[]> {
    const channelIds = Object.keys(cursors).slice(0, MAX_CHANNELS);
    if (channelIds.length === 0) return [];
    const heads = await this.sequelize.query<{ channelId: string; lastSeq: number }>(
      `SELECT c.id AS "channelId", c."lastSeq"::int AS "lastSeq"
       FROM "ChatChannel" c JOIN "ChatChannelMember" m ON m."channelId" = c.id AND m."userId" = :userId AND m.status = 'ACTIVE'
       WHERE c.id IN (:channelIds)`,
      { type: QueryTypes.SELECT, replacements: { userId, channelIds } },
    );

    const fromTail: ChannelSync[] = [];
    const fromDb: { channelId: string; since: number; lastSeq: number }[] = [];
    for (const { channelId, lastSeq } of heads) {
      const since = Math.max(0, Math.floor(cursors[channelId] ?? 0));
      if (since >= lastSeq) fromTail.push({ channelId, messages: [], lastSeq, hasMore: false });
      else if (lastSeq - since <= TAIL) fromTail.push({ channelId, messages: (await this.tail(channelId, lastSeq)).filter((m) => m.seq > since), lastSeq, hasMore: false });
      else fromDb.push({ channelId, since, lastSeq });
    }
    if (fromDb.length === 0) return fromTail;

    const rows = await this.sequelize.query<SyncedMessage & { channelId: string }>(
      `SELECT c.channel_id AS "channelId", m.*
       FROM unnest(CAST(:ids AS uuid[]), CAST(:sinces AS bigint[])) AS c(channel_id, since)
       CROSS JOIN LATERAL (
         SELECT id, seq::int AS seq, "authorId", CASE WHEN "deletedAt" IS NULL THEN body END AS body, "replyToId", "createdAt", "deletedAt" IS NOT NULL AS deleted
         FROM "ChatMessage" WHERE "channelId" = c.channel_id AND seq > c.since ORDER BY seq LIMIT :limit
       ) m`,
      { type: QueryTypes.SELECT, replacements: { ids: `{${fromDb.map((c) => c.channelId).join(',')}}`, sinces: `{${fromDb.map((c) => c.since).join(',')}}`, limit: PER_CHANNEL + 1 } },
    );
    const byChannel = new Map<string, SyncedMessage[]>();
    for (const { channelId, ...m } of rows) byChannel.set(channelId, [...(byChannel.get(channelId) ?? []), m]);
    return [
      ...fromTail,
      ...fromDb.map(({ channelId, lastSeq }) => {
        const messages = byChannel.get(channelId) ?? [];
        return { channelId, messages: messages.slice(0, PER_CHANNEL), lastSeq, hasMore: messages.length > PER_CHANNEL };
      }),
    ];
  }

  /** Unread = channel.lastSeq − member.lastReadSeq, for every channel of the user in one indexed query. */
  async unread(userId: string): Promise<{ channelId: string; unread: number; lastSeq: number }[]> {
    return this.sequelize.query(
      `SELECT c.id AS "channelId", (c."lastSeq" - m."lastReadSeq")::int AS unread, c."lastSeq"::int AS "lastSeq"
       FROM "ChatChannelMember" m JOIN "ChatChannel" c ON c.id = m."channelId"
       WHERE m."userId" = :userId AND m.status = 'ACTIVE' AND NOT c."isArchived"
       ORDER BY c."lastMessageAt" DESC NULLS LAST LIMIT 200`,
      { type: QueryTypes.SELECT, replacements: { userId } },
    );
  }

  /**
   * Read receipt: monotonic (GREATEST - an old tab can't move it back),
   * capped at the channel's lastSeq, published to members over SSE only when
   * it actually advanced (throttles receipt storms from scrolling).
   */
  async markRead(channelId: string, userId: string, seq: number): Promise<{ lastReadSeq: number; unread: number }> {
    const [row] = await this.sequelize.query<{ lastReadSeq: number; lastSeq: number; advanced: boolean }>(
      `WITH prev AS (SELECT m.id, m."lastReadSeq" FROM "ChatChannelMember" m WHERE m."channelId" = :channelId AND m."userId" = :userId AND m.status = 'ACTIVE' FOR UPDATE)
       UPDATE "ChatChannelMember" m
       SET "lastReadSeq" = GREATEST(prev."lastReadSeq", LEAST(:seq, c."lastSeq")), "lastReadAt" = now()
       FROM prev, "ChatChannel" c
       WHERE m.id = prev.id AND c.id = :channelId
       RETURNING m."lastReadSeq"::int AS "lastReadSeq", c."lastSeq"::int AS "lastSeq", m."lastReadSeq" > prev."lastReadSeq" AS advanced`,
      { type: QueryTypes.SELECT, replacements: { channelId, userId, seq } },
    );
    if (!row) throw new NotFoundException('Not a member of this channel');
    if (row.advanced) await this.realtime.publish(`chat:${channelId}`, 'read', { userId, seq: row.lastReadSeq }, { replay: false });
    return { lastReadSeq: row.lastReadSeq, unread: row.lastSeq - row.lastReadSeq };
  }

  /**
   * Presence: heartbeat every ~30 s → key with 60 s TTL. Broadcast only on the
   * offline → online transition (SET ... GET returns null), to the user's 20
   * most recently active channels - not on every heartbeat.
   */
  async heartbeat(userId: string): Promise<void> {
    const previous = await this.redis.client.set(presenceKey(userId), String(Date.now()), 'EX', PRESENCE_TTL_SEC, 'GET');
    if (previous !== null) return;
    const channels = await this.sequelize.query<{ channelId: string }>(
      `SELECT m."channelId" FROM "ChatChannelMember" m JOIN "ChatChannel" c ON c.id = m."channelId"
       WHERE m."userId" = :userId AND m.status = 'ACTIVE' ORDER BY c."lastMessageAt" DESC NULLS LAST LIMIT 20`,
      { type: QueryTypes.SELECT, replacements: { userId } },
    );
    for (const { channelId } of channels) await this.realtime.publish(`chat:${channelId}`, 'presence', { userId, online: true }, { replay: false });
  }

  async presence(userIds: string[]): Promise<Record<string, { online: boolean; lastSeenAt: number | null }>> {
    if (userIds.length === 0) return {};
    const values = await Promise.all(userIds.map((id) => this.redis.client.get(presenceKey(id))));
    return Object.fromEntries(userIds.map((id, i) => [id, { online: values[i] !== null, lastSeenAt: values[i] ? Number(values[i]) : null }]));
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.redis.client.exists(presenceKey(userId))) === 1;
  }

  private async tail(channelId: string, lastSeq: number): Promise<SyncedMessage[]> {
    return (
      (await this.cache.getOrLoad<SyncedMessage[]>(
        tailKey(channelId, lastSeq),
        () =>
          this.sequelize.query<SyncedMessage>(
            `SELECT id, seq::int AS seq, "authorId", CASE WHEN "deletedAt" IS NULL THEN body END AS body, "replyToId", "createdAt", "deletedAt" IS NOT NULL AS deleted
             FROM "ChatMessage" WHERE "channelId" = :channelId AND seq > :from AND seq <= :lastSeq ORDER BY seq`,
            { type: QueryTypes.SELECT, replacements: { channelId, from: lastSeq - TAIL, lastSeq } },
          ),
        // Short TTL: a moderation delete inside the tail shows up within 30 s (the WS bus delivers it instantly anyway).
        { ttlMs: 30_000, l1: 'hot' },
      )) ?? []
    );
  }

  private async assertCanPost(channelId: string, userId: string) {
    const [member] = await this.sequelize.query<{ status: string; mutedUntil: Date | null; isArchived: boolean }>(
      `SELECT m.status, m."mutedUntil", c."isArchived" FROM "ChatChannelMember" m JOIN "ChatChannel" c ON c.id = m."channelId"
       WHERE m."channelId" = :channelId AND m."userId" = :userId`,
      { type: QueryTypes.SELECT, replacements: { channelId, userId } },
    );
    if (!member) throw new NotFoundException('Channel not found');
    if (member.status !== 'ACTIVE' || member.isArchived || (member.mutedUntil && new Date(member.mutedUntil) > new Date())) throw new ForbiddenException('You cannot post in this channel');
  }
}
