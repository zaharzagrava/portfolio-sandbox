import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  ReadPosition,
  ReadStateRepository,
  UnreadEntry,
} from '../domain/ports';
import { safeNumber, select } from './sql';

interface PositionRow {
  lastReadSeq: string | number;
  lastSeq: string | number;
  activeMemberCount: number;
}

/** Read positions and the unread list (S24 data-model §3). The membership predicate is in every statement. */
@Injectable()
export class SequelizeReadStateRepository implements ReadStateRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  /**
   * One conditional update: the new position is computed from the row's own value, so a concurrent request that
   * committed first is seen after the lock wait (the row is re-evaluated) and a stale request changes nothing. Only
   * when nothing changed does a read-only query tell "stale" from "not a member".
   */
  async advance(
    channelId: string,
    userId: string,
    seq: number,
    now: Date,
  ): Promise<ReadPosition | null> {
    const advanced = await select<PositionRow>(
      this.sequelize,
      `UPDATE "ChatChannelMember" m
          SET "lastReadSeq" = LEAST(GREATEST(m."lastReadSeq", CAST(:seq AS bigint)), c."lastSeq"), "lastReadAt" = :now, "updatedAt" = :now
         FROM "ChatChannel" c
        WHERE m."channelId" = :channelId AND m."userId" = :userId AND m.status = 'ACTIVE' AND c.id = m."channelId"
          AND LEAST(GREATEST(m."lastReadSeq", CAST(:seq AS bigint)), c."lastSeq") > m."lastReadSeq"
       RETURNING m."lastReadSeq", c."lastSeq", c."activeMemberCount"`,
      { channelId, userId, seq, now },
    );
    if (advanced.length) return { ...toPosition(advanced[0]), advanced: true };

    const current = await select<PositionRow>(
      this.sequelize,
      `SELECT m."lastReadSeq", c."lastSeq", c."activeMemberCount"
         FROM "ChatChannelMember" m JOIN "ChatChannel" c ON c.id = m."channelId"
        WHERE m."channelId" = :channelId AND m."userId" = :userId AND m.status = 'ACTIVE'`,
      { channelId, userId },
    );
    return current.length
      ? { ...toPosition(current[0]), advanced: false }
      : null;
  }

  async unreadPage(
    userId: string,
    limit: number,
    after: { at: string; channelId: string } | null,
  ): Promise<UnreadEntry[]> {
    const rows = await select<{
      channelId: string;
      lastSeq: string | number;
      lastReadSeq: string | number;
      activityAt: string;
    }>(
      this.sequelize,
      `SELECT c.id AS "channelId", c."lastSeq", m."lastReadSeq", COALESCE(c."lastMessageAt", c."createdAt")::text AS "activityAt"
         FROM "ChatChannelMember" m
         JOIN "ChatChannel" c ON c.id = m."channelId"
        WHERE m."userId" = :userId AND m.status = 'ACTIVE' AND c."isArchived" = false
          AND (CAST(:afterAt AS text) IS NULL
               OR (COALESCE(c."lastMessageAt", c."createdAt"), c.id) < (CAST(:afterAt AS timestamptz), CAST(:afterId AS uuid)))
        ORDER BY COALESCE(c."lastMessageAt", c."createdAt") DESC, c.id DESC
        LIMIT :limit`,
      {
        userId,
        limit,
        afterAt: after?.at ?? null,
        afterId: after?.channelId ?? null,
      },
    );
    return rows.map((r) => ({
      channelId: r.channelId,
      lastSeq: safeNumber(r.lastSeq),
      unread: Math.max(0, safeNumber(r.lastSeq) - safeNumber(r.lastReadSeq)),
      activityAt: r.activityAt,
    }));
  }
}

const toPosition = (r: PositionRow): Omit<ReadPosition, 'advanced'> => ({
  lastReadSeq: safeNumber(r.lastReadSeq),
  lastSeq: safeNumber(r.lastSeq),
  activeMemberCount: r.activeMemberCount,
});
