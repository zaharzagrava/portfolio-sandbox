import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  ChatChannelMemberRole,
  ChatChannelMemberStatus,
} from '../domain/chat.constants';
import type {
  JoinOutcome,
  MemberRecord,
  MembershipRepository,
} from '../domain/ports';
import { toMember } from './channel.repository';
import { select } from './sql';

const MEMBER_COLUMNS = `m."channelId", m."userId", m.role::text AS role, m.status::text AS status, m."mutedUntil", m."lastReadSeq"`;

type MemberRow = Parameters<typeof toMember>[0];

/** `ChatChannelMember`. Every change is one conditional statement asserting the row it expects (R-04, G-02, G-03). */
@Injectable()
export class SequelizeMembershipRepository implements MembershipRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  /**
   * One conditional insert that never touches role, status or position of an existing row: a joiner starts at the
   * channel's current sequence (no backlog), ten simultaneous joins leave one row. A refused insert is diagnosed by a
   * read-only query that only picks the answer; it grants nothing.
   */
  async join(
    channelId: string,
    userId: string,
    now: Date,
  ): Promise<JoinOutcome> {
    const inserted = await select<MemberRow>(
      this.sequelize,
      `INSERT INTO "ChatChannelMember" (id, "channelId", "userId", role, status, "lastReadSeq", "createdAt", "updatedAt")
       SELECT uuidv7(), c.id, :userId, CAST(:role AS "enum_ChatChannelMember_role"),
              CAST('ACTIVE' AS "enum_ChatChannelMember_status"), c."lastSeq", :now, :now
         FROM "ChatChannel" c WHERE c.id = :channelId AND c."isArchived" = false
       ON CONFLICT ("channelId", "userId") DO NOTHING
       RETURNING "channelId", "userId", role::text AS role, status::text AS status, "mutedUntil", "lastReadSeq"`,
      { channelId, userId, now, role: ChatChannelMemberRole.MEMBER },
    );
    if (inserted.length)
      return { kind: 'joined', member: toMember(inserted[0]) };

    const diagnosis = await select<
      { isArchived: boolean } & Partial<MemberRow>
    >(
      this.sequelize,
      `SELECT c."isArchived", ${MEMBER_COLUMNS}
         FROM "ChatChannel" c
         LEFT JOIN "ChatChannelMember" m ON m."channelId" = c.id AND m."userId" = :userId
        WHERE c.id = :channelId`,
      { channelId, userId },
    );
    if (!diagnosis.length) return { kind: 'not_found' };
    const row = diagnosis[0];
    if (row.status === ChatChannelMemberStatus.BANNED)
      return { kind: 'banned' };
    if (row.isArchived) return { kind: 'archived' };
    if (row.userId)
      return { kind: 'exists', member: toMember(row as MemberRow) };
    // the channel was archived or deleted between the statements: refuse like the first reading would have
    return { kind: 'archived' };
  }

  async find(channelId: string, userId: string): Promise<MemberRecord | null> {
    const rows = await select<MemberRow>(
      this.sequelize,
      `SELECT ${MEMBER_COLUMNS} FROM "ChatChannelMember" m WHERE m."channelId" = :channelId AND m."userId" = :userId`,
      { channelId, userId },
    );
    return rows.length ? toMember(rows[0]) : null;
  }

  async changeStatus(
    channelId: string,
    userId: string,
    from: ChatChannelMemberStatus,
    to: ChatChannelMemberStatus,
  ): Promise<boolean> {
    const rows = await select<object>(
      this.sequelize,
      `UPDATE "ChatChannelMember" SET status = :to, "updatedAt" = now()
        WHERE "channelId" = :channelId AND "userId" = :userId AND status = :from RETURNING 1 AS one`,
      { channelId, userId, from, to },
    );
    return rows.length === 1;
  }

  async changeRole(
    channelId: string,
    userId: string,
    from: ChatChannelMemberRole,
    to: ChatChannelMemberRole,
  ): Promise<boolean> {
    const rows = await select<object>(
      this.sequelize,
      `UPDATE "ChatChannelMember" SET role = :to, "updatedAt" = now()
        WHERE "channelId" = :channelId AND "userId" = :userId AND role = :from RETURNING 1 AS one`,
      { channelId, userId, from, to },
    );
    return rows.length === 1;
  }

  async setMute(
    channelId: string,
    userId: string,
    mutedUntil: Date,
    now: Date,
  ): Promise<boolean> {
    const rows = await select<object>(
      this.sequelize,
      `UPDATE "ChatChannelMember" SET "mutedUntil" = :mutedUntil, "updatedAt" = :now
        WHERE "channelId" = :channelId AND "userId" = :userId RETURNING 1 AS one`,
      { channelId, userId, mutedUntil, now },
    );
    return rows.length === 1;
  }

  async clearMute(
    channelId: string,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await select<object>(
      this.sequelize,
      `UPDATE "ChatChannelMember" SET "mutedUntil" = NULL, "updatedAt" = :now
        WHERE "channelId" = :channelId AND "userId" = :userId AND "mutedUntil" > :now RETURNING 1 AS one`,
      { channelId, userId, now },
    );
    return rows.length === 1;
  }

  async activeMembers(
    channelId: string,
    exceptUserId: string,
    limit: number,
  ): Promise<string[]> {
    const rows = await select<{ userId: string }>(
      this.sequelize,
      `SELECT "userId" FROM "ChatChannelMember"
        WHERE "channelId" = :channelId AND status = 'ACTIVE' AND "userId" <> :exceptUserId
        ORDER BY "userId" LIMIT :limit`,
      { channelId, exceptUserId, limit },
    );
    return rows.map((r) => r.userId);
  }

  async coMembers(userId: string, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await select<{ userId: string }>(
      this.sequelize,
      `SELECT DISTINCT o."userId"
         FROM "ChatChannelMember" mine
         JOIN "ChatChannelMember" o ON o."channelId" = mine."channelId" AND o.status = 'ACTIVE'
        WHERE mine."userId" = :userId AND mine.status = 'ACTIVE' AND o."userId" IN (:userIds)`,
      { userId, userIds },
    );
    return rows.map((r) => r.userId);
  }

  async recentChannels(
    userId: string,
    limit: number,
  ): Promise<Array<{ channelId: string; activeMemberCount: number }>> {
    return select<{ channelId: string; activeMemberCount: number }>(
      this.sequelize,
      `SELECT m."channelId", c."activeMemberCount"
         FROM "ChatChannelMember" m
         JOIN "ChatChannel" c ON c.id = m."channelId"
        WHERE m."userId" = :userId AND m.status = 'ACTIVE'
        ORDER BY c."lastMessageAt" DESC NULLS LAST, c.id DESC LIMIT :limit`,
      { userId, limit },
    );
  }
}
