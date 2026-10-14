import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { chatPartitionMissingCounter } from '../domain/chat-metrics';
import type {
  InsertOutcome,
  MessageRecord,
  MessageRepository,
} from '../domain/ports';
import { pgCode, safeNumber, select } from './sql';

const UNIQUE_VIOLATION = '23505';

interface Row {
  id: string;
  channelId: string;
  seq: string | number;
  authorId: string;
  body: string;
  replyToId: string | null;
  clientMessageId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

const toMessage = (r: Row): MessageRecord => ({
  id: r.id,
  channelId: r.channelId,
  seq: safeNumber(r.seq),
  authorId: r.authorId,
  body: r.body,
  replyToId: r.replyToId,
  clientMessageId: r.clientMessageId,
  createdAt: r.createdAt,
  deletedAt: r.deletedAt,
});

/** Message columns of a row joined from `ChatMessageIndex i` to `ChatMessage m` (partition pruned by `createdAt`). */
const M_COLUMNS = `m.id, m."channelId", m.seq, m."authorId", m.body, m."replyToId", m."clientMessageId", m."createdAt", m."deletedAt"`;
const JOIN_INDEX = `"ChatMessageIndex" i JOIN "ChatMessage" m ON m.id = i."messageId" AND m."createdAt" = i."createdAt"`;

/** `ChatMessage` and its index (S24 data-model §1, R-02, R-04). Statements join the active transaction (CLS). */
@Injectable()
export class SequelizeMessageRepository implements MessageRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  /**
   * One statement decides (R-04): membership, ban, mute, archive and the reply target are all in the `WHERE` of the
   * insert, so a decision never races a moderator. The sequence number and the index row come from the insert trigger;
   * a unique violation there (same author and client id) aborts the statement and rolls the number back, so a replay
   * or a rejected write consumes nothing. Zero rows: one read-only diagnosis picks the answer; it grants nothing.
   */
  async insertIfAllowed(input: {
    channelId: string;
    authorId: string;
    clientMessageId: string;
    body: string;
    replyToId: string | null;
    now: Date;
  }): Promise<InsertOutcome> {
    try {
      const inserted = await select<Row & { part: string }>(
        this.sequelize,
        `INSERT INTO "ChatMessage" (id, "channelId", "authorId", body, "replyToId", "clientMessageId", "createdAt")
         SELECT uuidv7(), c.id, :authorId, :body, CAST(:replyToId AS uuid), :clientMessageId, :now
           FROM "ChatChannel" c
           JOIN "ChatChannelMember" m ON m."channelId" = c.id AND m."userId" = :authorId AND m.status = 'ACTIVE'
          WHERE c.id = :channelId AND c."isArchived" = false
            AND (m."mutedUntil" IS NULL OR m."mutedUntil" <= :now)
            AND (CAST(:replyToId AS uuid) IS NULL
                 OR EXISTS (SELECT 1 FROM "ChatMessageIndex" r WHERE r."channelId" = c.id AND r."messageId" = CAST(:replyToId AS uuid)))
         RETURNING id, "channelId", seq, "authorId", body, "replyToId", "clientMessageId", "createdAt", "deletedAt",
                   tableoid::regclass::text AS part`,
        input,
      );
      if (inserted.length) {
        // no insert is ever refused for a missing month; the default partition catches it and this counts it (AS-29)
        if (
          inserted[0].part === '"ChatMessage_default"' ||
          inserted[0].part === 'ChatMessage_default'
        ) {
          chatPartitionMissingCounter.add(1);
        }
        return { kind: 'created', message: toMessage(inserted[0]) };
      }
    } catch (error) {
      if (pgCode(error) !== UNIQUE_VIOLATION) throw error;
      const replay = await this.findByKey(input);
      if (replay) return { kind: 'replay', ...replay };
      throw error;
    }
    return this.diagnose(input);
  }

  private async findByKey(input: {
    channelId: string;
    authorId: string;
    clientMessageId: string;
    body: string;
    replyToId: string | null;
  }): Promise<{ message: MessageRecord; sameContent: boolean } | null> {
    const found = await select<Row & { sameContent: boolean }>(
      this.sequelize,
      `SELECT ${M_COLUMNS},
              i."bodyHash" = sha256(convert_to(CAST(:body AS text) || chr(31) || coalesce(CAST(:replyToId AS text), ''), 'UTF8')) AS "sameContent"
         FROM ${JOIN_INDEX}
        WHERE i."channelId" = :channelId AND i."authorId" = :authorId AND i."clientMessageId" = :clientMessageId`,
      input,
    );
    return found.length
      ? { message: toMessage(found[0]), sameContent: found[0].sameContent }
      : null;
  }

  private async diagnose(input: {
    channelId: string;
    authorId: string;
    now: Date;
  }): Promise<InsertOutcome> {
    const rows = await select<{
      isArchived: boolean;
      status: string | null;
      mutedUntil: Date | null;
    }>(
      this.sequelize,
      `SELECT c."isArchived", m.status::text AS status, m."mutedUntil"
         FROM "ChatChannel" c
         LEFT JOIN "ChatChannelMember" m ON m."channelId" = c.id AND m."userId" = :authorId
        WHERE c.id = :channelId`,
      input,
    );
    if (!rows.length || rows[0].status === null)
      return { kind: 'refused', reason: 'not_found' };
    const row = rows[0];
    if (row.status === 'BANNED') return { kind: 'refused', reason: 'banned' };
    if (row.isArchived) return { kind: 'refused', reason: 'archived' };
    if (row.mutedUntil && row.mutedUntil.getTime() > input.now.getTime()) {
      return { kind: 'refused', reason: 'muted', mutedUntil: row.mutedUntil };
    }
    return { kind: 'refused', reason: 'reply_target_invalid' };
  }

  async listSince(
    channelId: string,
    afterSeq: number,
    toSeq: number,
  ): Promise<MessageRecord[]> {
    const found = await select<Row>(
      this.sequelize,
      `SELECT ${M_COLUMNS} FROM ${JOIN_INDEX}
        WHERE i."channelId" = :channelId AND i.seq > :afterSeq AND i.seq <= :toSeq
        ORDER BY i.seq`,
      { channelId, afterSeq, toSeq },
    );
    return found.map(toMessage);
  }

  async listPage(
    channelId: string,
    beforeSeq: number | null,
    limit: number,
  ): Promise<MessageRecord[]> {
    const found = await select<Row>(
      this.sequelize,
      `SELECT ${M_COLUMNS} FROM ${JOIN_INDEX}
        WHERE i."channelId" = :channelId AND (CAST(:beforeSeq AS bigint) IS NULL OR i.seq < CAST(:beforeSeq AS bigint))
        ORDER BY i.seq DESC LIMIT :limit`,
      { channelId, beforeSeq, limit },
    );
    return found.map(toMessage);
  }

  async authorOf(
    channelId: string,
    messageId: string,
  ): Promise<{ authorId: string; deleted: boolean } | null> {
    const found = await select<{ authorId: string; deleted: boolean }>(
      this.sequelize,
      `SELECT i."authorId", m."deletedAt" IS NOT NULL AS deleted
         FROM ${JOIN_INDEX}
        WHERE i."channelId" = :channelId AND i."messageId" = :messageId`,
      { channelId, messageId },
    );
    return found[0] ?? null;
  }

  async softDelete(
    channelId: string,
    messageId: string,
    deletedBy: string,
    now: Date,
  ): Promise<'deleted' | 'already' | 'missing'> {
    const changed = await select<object>(
      this.sequelize,
      `UPDATE "ChatMessage" m SET "deletedAt" = :now, "deletedBy" = :deletedBy
         FROM "ChatMessageIndex" i
        WHERE i."channelId" = :channelId AND i."messageId" = :messageId
          AND m.id = i."messageId" AND m."createdAt" = i."createdAt" AND m."deletedAt" IS NULL
       RETURNING 1 AS one`,
      { channelId, messageId, deletedBy, now },
    );
    if (changed.length) return 'deleted';
    const existing = await select<object>(
      this.sequelize,
      `SELECT 1 AS one FROM "ChatMessageIndex" WHERE "channelId" = :channelId AND "messageId" = :messageId`,
      { channelId, messageId },
    );
    return existing.length ? 'already' : 'missing';
  }
}
