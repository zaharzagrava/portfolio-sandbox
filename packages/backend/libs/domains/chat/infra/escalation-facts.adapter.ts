import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { EscalationFacts, EscalationFactsPort } from '../domain/ports';
import { safeNumber, select } from './sql';

/**
 * What the offline check needs to know, in one read: the channel (title, archived), the recipient's membership and read
 * position, and whether the message still exists undeleted. No `User` join: chat names no one (S01 follow-up).
 */
@Injectable()
export class EscalationFactsAdapter implements EscalationFactsPort {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async load(input: {
    channelId: string;
    messageId: string;
    recipientId: string;
  }): Promise<EscalationFacts> {
    const [row] = await select<{
      title: string;
      isArchived: boolean;
      status: string | null;
      lastReadSeq: string | number | null;
      messageExists: boolean;
      messageDeleted: boolean | null;
    }>(
      this.sequelize,
      `SELECT c.title, c."isArchived", m.status::text AS status, m."lastReadSeq",
              EXISTS (SELECT 1 FROM "ChatMessageIndex" i WHERE i."channelId" = c.id AND i."messageId" = :messageId) AS "messageExists",
              (SELECT msg."deletedAt" IS NOT NULL
                 FROM "ChatMessageIndex" i
                 JOIN "ChatMessage" msg ON msg.id = i."messageId" AND msg."createdAt" = i."createdAt"
                WHERE i."channelId" = c.id AND i."messageId" = :messageId) AS "messageDeleted"
         FROM "ChatChannel" c
         LEFT JOIN "ChatChannelMember" m ON m."channelId" = c.id AND m."userId" = :recipientId
        WHERE c.id = :channelId`,
      input,
    );
    if (!row) {
      // the channel is gone (purged): nothing to notify about
      return { eligible: false, deleted: true, readSeq: 0, channelTitle: '' };
    }
    return {
      eligible: row.status === 'ACTIVE' && !row.isArchived,
      deleted: !row.messageExists || row.messageDeleted === true,
      readSeq: row.lastReadSeq === null ? 0 : safeNumber(row.lastReadSeq),
      channelTitle: row.title,
    };
  }
}
