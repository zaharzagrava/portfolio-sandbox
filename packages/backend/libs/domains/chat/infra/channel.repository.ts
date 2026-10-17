import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import { ChatChannelMemberRole } from '../domain/chat.constants';
import type { InboxCursor } from '../domain/history-cursor';
import type {
  ChannelRecord,
  ChannelRepository,
  InboxEntry,
  MemberRecord,
} from '../domain/ports';
import { safeNumber, select } from './sql';

const COLUMNS = `c.id, c."productId", c."shopId", c."sellerId", c.title, c."isArchived", c."archivedAt", c."lastSeq",
  c."activeMemberCount", c."createdAt", c."updatedAt"`;

interface Row {
  id: string;
  productId: string;
  shopId: string;
  sellerId: string;
  title: string;
  isArchived: boolean;
  archivedAt: Date | null;
  lastSeq: string | number;
  activeMemberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export const toChannel = (r: Row): ChannelRecord => ({
  id: r.id,
  productId: r.productId,
  shopId: r.shopId,
  sellerId: r.sellerId,
  title: r.title,
  isArchived: r.isArchived,
  archivedAt: r.archivedAt,
  lastSeq: safeNumber(r.lastSeq),
  activeMemberCount: r.activeMemberCount,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

interface MemberRow {
  role: string;
  status: string;
  mutedUntil: Date | null;
  lastReadSeq: string | number;
  userId: string;
  channelId: string;
}

export const toMember = (r: MemberRow): MemberRecord => ({
  channelId: r.channelId,
  userId: r.userId,
  role: r.role as MemberRecord['role'],
  status: r.status as MemberRecord['status'],
  mutedUntil: r.mutedUntil,
  lastReadSeq: safeNumber(r.lastReadSeq),
});

const MEMBER_COLUMNS = `m."channelId", m."userId", m.role::text AS role, m.status::text AS status, m."mutedUntil", m."lastReadSeq"`;

/** `ChatChannel` (S24 data-model §1). Every read of a channel by a caller carries the membership predicate (III.4). */
@Injectable()
export class SequelizeChannelRepository implements ChannelRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
  ) {}

  async createIfAbsent(input: {
    productId: string;
    shopId: string;
    sellerId: string;
    title: string;
    ownerUserId: string;
    now: Date;
  }): Promise<ChannelRecord | null> {
    return this.runner.run(async () => {
      const created = await select<Row>(
        this.sequelize,
        `INSERT INTO "ChatChannel" (id, "productId", "shopId", "sellerId", title, "isArchived", "lastSeq", "activeMemberCount", "deleteEpoch", "createdAt", "updatedAt")
         VALUES (uuidv7(), :productId, :shopId, :sellerId, :title, false, 0, 0, 0, :now, :now)
         ON CONFLICT ("productId") DO NOTHING
         RETURNING id, "productId", "shopId", "sellerId", title, "isArchived", "archivedAt", "lastSeq", "activeMemberCount", "createdAt", "updatedAt"`,
        input,
      );
      if (created.length === 0) return null;
      await this.sequelize.query(
        `INSERT INTO "ChatChannelMember" (id, "channelId", "userId", role, status, "lastReadSeq", "createdAt", "updatedAt")
         VALUES (uuidv7(), :channelId, :userId, :role, 'ACTIVE', 0, :now, :now)`,
        {
          replacements: {
            channelId: created[0].id,
            userId: input.ownerUserId,
            role: ChatChannelMemberRole.OWNER,
            now: input.now,
          },
        },
      );
      return toChannel({ ...created[0], activeMemberCount: 1 });
    });
  }

  async findForMember(channelId: string, userId: string) {
    const rows = await select<Row & MemberRow>(
      this.sequelize,
      `SELECT ${COLUMNS}, ${MEMBER_COLUMNS}
         FROM "ChatChannel" c
         JOIN "ChatChannelMember" m ON m."channelId" = c.id AND m."userId" = :userId AND m.status = 'ACTIVE'
        WHERE c.id = :channelId`,
      { channelId, userId },
    );
    return rows.length
      ? { channel: toChannel(rows[0]), member: toMember(rows[0]) }
      : null;
  }

  async findByProduct(productId: string, userId: string) {
    const rows = await select<Row & Partial<MemberRow>>(
      this.sequelize,
      `SELECT ${COLUMNS}, m."channelId", m."userId", m.role::text AS role, m.status::text AS status, m."mutedUntil", m."lastReadSeq"
         FROM "ChatChannel" c
         LEFT JOIN "ChatChannelMember" m ON m."channelId" = c.id AND m."userId" = :userId AND m.status = 'ACTIVE'
        WHERE c."productId" = :productId`,
      { productId, userId },
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      channel: toChannel(row),
      member: row.userId ? toMember(row as MemberRow) : null,
    };
  }

  async findById(channelId: string): Promise<ChannelRecord | null> {
    const rows = await select<Row>(
      this.sequelize,
      `SELECT ${COLUMNS} FROM "ChatChannel" c WHERE c.id = :channelId`,
      { channelId },
    );
    return rows.length ? toChannel(rows[0]) : null;
  }

  async listMine(
    userId: string,
    limit: number,
    after: InboxCursor | null,
  ): Promise<InboxEntry[]> {
    const rows = await select<Row & MemberRow & { lastMessageAtText: string | null }>(
      this.sequelize,
      `SELECT ${COLUMNS}, ${MEMBER_COLUMNS}, c."lastMessageAt"::text AS "lastMessageAtText"
         FROM "ChatChannelMember" m
         JOIN "ChatChannel" c ON c.id = m."channelId"
        WHERE m."userId" = :userId AND m.status = 'ACTIVE'
          AND (CAST(:hasCursor AS boolean) = false
               OR c."isArchived" > CAST(:archived AS boolean)
               OR (c."isArchived" = CAST(:archived AS boolean)
                   AND (CASE WHEN CAST(:at AS text) IS NOT NULL
                             THEN (c."lastMessageAt" IS NULL OR c."lastMessageAt" < CAST(:at AS timestamptz)
                                   OR (c."lastMessageAt" = CAST(:at AS timestamptz) AND c.id < CAST(:channelId AS uuid)))
                             ELSE (c."lastMessageAt" IS NULL AND c.id < CAST(:channelId AS uuid)) END)))
        ORDER BY c."isArchived" ASC, c."lastMessageAt" DESC NULLS LAST, c.id DESC
        LIMIT :limit`,
      {
        userId,
        limit,
        hasCursor: after !== null,
        archived: after?.archived ?? false,
        at: after?.at ?? null,
        channelId: after?.channelId ?? null,
      },
    );
    return rows.map((r) => ({
      channel: toChannel(r),
      member: toMember(r),
      lastMessageAt: r.lastMessageAtText,
    }));
  }

  async setArchived(
    channelId: string,
    from: boolean,
    now: Date,
  ): Promise<ChannelRecord | null> {
    const rows = await select<Row>(
      this.sequelize,
      `UPDATE "ChatChannel" c
          SET "isArchived" = NOT :from, "archivedAt" = CASE WHEN :from THEN NULL ELSE CAST(:now AS timestamptz) END, "updatedAt" = :now
        WHERE c.id = :channelId AND c."isArchived" = :from
       RETURNING ${COLUMNS}`,
      { channelId, from, now },
    );
    return rows.length ? toChannel(rows[0]) : null;
  }

  async lock(channelId: string): Promise<void> {
    await select<object>(
      this.sequelize,
      `SELECT 1 AS one FROM "ChatChannel" WHERE id = :channelId FOR UPDATE`,
      { channelId },
    );
  }

  async bumpDeleteEpoch(channelId: string): Promise<void> {
    await select<object>(
      this.sequelize,
      `UPDATE "ChatChannel" SET "deleteEpoch" = "deleteEpoch" + 1 WHERE id = :channelId RETURNING 1 AS one`,
      { channelId },
    );
  }

  async setTitle(
    channelId: string,
    title: string,
    now: Date,
  ): Promise<ChannelRecord | null> {
    const rows = await select<Row>(
      this.sequelize,
      `UPDATE "ChatChannel" c SET title = :title, "updatedAt" = :now WHERE c.id = :channelId RETURNING ${COLUMNS}`,
      { channelId, title, now },
    );
    return rows.length ? toChannel(rows[0]) : null;
  }
}
