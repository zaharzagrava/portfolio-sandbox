import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { PurgeRepository } from '../domain/ports';
import { select } from './sql';

/**
 * Bounded deletes for a deleted shop (S24 FR-043, R-12): every statement removes at most `limit` rows, so a big channel
 * never holds a long lock. The statements are idempotent; a second consumer racing the first finds the rows gone.
 */
@Injectable()
export class SequelizePurgeRepository implements PurgeRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async channelIdsOfShop(shopId: string, limit: number): Promise<string[]> {
    const rows = await select<{ id: string }>(
      this.sequelize,
      `SELECT id FROM "ChatChannel" WHERE "shopId" = :shopId ORDER BY id LIMIT :limit`,
      { shopId, limit },
    );
    return rows.map((r) => r.id);
  }

  async deleteMessagesBatch(channelId: string, limit: number): Promise<number> {
    // through the index: the (id, createdAt) pairs prune the monthly partitions
    const [indexed] = await select<{ n: number }>(
      this.sequelize,
      `WITH victims AS (
         SELECT "messageId", "createdAt" FROM "ChatMessageIndex" WHERE "channelId" = :channelId LIMIT ${Number(limit)}
       ), dm AS (
         DELETE FROM "ChatMessage" m USING victims v WHERE m.id = v."messageId" AND m."createdAt" = v."createdAt" RETURNING 1
       ), di AS (
         DELETE FROM "ChatMessageIndex" i USING victims v WHERE i."channelId" = :channelId AND i."messageId" = v."messageId" RETURNING 1
       )
       SELECT (SELECT count(*) FROM victims)::int AS n`,
      { channelId },
    );
    if (indexed.n > 0) return indexed.n;
    // rows without an index row (never written by the trigger): the channel's remainder
    const rest = await select<object>(
      this.sequelize,
      `DELETE FROM "ChatMessage" WHERE id IN (SELECT id FROM "ChatMessage" WHERE "channelId" = :channelId LIMIT ${Number(limit)}) RETURNING 1 AS one`,
      { channelId },
    );
    return rest.length;
  }

  async deleteMembersBatch(channelId: string, limit: number): Promise<number> {
    const rows = await select<object>(
      this.sequelize,
      `DELETE FROM "ChatChannelMember" WHERE id IN (SELECT id FROM "ChatChannelMember" WHERE "channelId" = :channelId LIMIT ${Number(limit)}) RETURNING 1 AS one`,
      { channelId },
    );
    return rows.length;
  }

  async deleteChannel(channelId: string): Promise<void> {
    await select<object>(
      this.sequelize,
      `DELETE FROM "ChatChannel" WHERE id = :channelId RETURNING 1 AS one`,
      { channelId },
    );
  }
}
