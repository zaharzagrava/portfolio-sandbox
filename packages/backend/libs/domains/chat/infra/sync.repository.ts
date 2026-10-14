import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  MessageRecord,
  ReadableChannel,
  SyncRepository,
  SyncWindow,
} from '../domain/ports';
import { safeNumber, select } from './sql';

interface IndexRow {
  messageId: string;
  /** Text, not a `Date`: a JavaScript date keeps milliseconds, rows written with `now()` have microseconds. */
  createdAt: string;
}

interface BodyRow {
  id: string;
  channelId: string;
  seq: string | number;
  authorId: string;
  body: string;
  replyToId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

/** Reads of `POST /chat/sync` (S24 FR-020, G-21): parameterised arrays, never string-built ids. */
@Injectable()
export class SequelizeSyncRepository implements SyncRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  /** Statement 1: the principal is in the predicate, so unreadable channels fall out without a trace. */
  async readable(
    userId: string,
    channelIds: string[],
  ): Promise<ReadableChannel[]> {
    if (channelIds.length === 0) return [];
    const rows = await select<{
      id: string;
      lastSeq: string | number;
      deleteEpoch: string | number;
    }>(
      this.sequelize,
      `SELECT c.id, c."lastSeq", c."deleteEpoch"
         FROM "ChatChannel" c
         JOIN "ChatChannelMember" m ON m."channelId" = c.id AND m."userId" = :userId AND m.status = 'ACTIVE'
        WHERE c.id IN (:channelIds)`,
      { userId, channelIds },
    );
    return rows.map((r) => ({
      id: r.id,
      lastSeq: safeNumber(r.lastSeq),
      deleteEpoch: String(r.deleteEpoch),
    }));
  }

  async loadWindows(
    windows: SyncWindow[],
  ): Promise<Map<string, MessageRecord[]>> {
    const out = new Map<string, MessageRecord[]>(
      windows.map((w) => [w.channelId, []]),
    );
    if (windows.length === 0) return out;

    // Statement 2: the index range of every window
    const values = windows
      .map(
        (_, i) =>
          `(CAST(:c${i} AS uuid), CAST(:a${i} AS bigint), CAST(:t${i} AS bigint))`,
      )
      .join(', ');
    const replacements: Record<string, unknown> = {};
    windows.forEach((w, i) => {
      replacements[`c${i}`] = w.channelId;
      replacements[`a${i}`] = w.afterSeq;
      replacements[`t${i}`] = w.toSeq;
    });
    const index = await select<IndexRow>(
      this.sequelize,
      `SELECT i."messageId", i."createdAt"::text AS "createdAt"
         FROM "ChatMessageIndex" i
         JOIN (VALUES ${values}) AS w(cid, after, upto) ON i."channelId" = w.cid AND i.seq > w.after AND i.seq <= w.upto`,
      replacements,
    );
    if (index.length === 0) return out;

    // Statement 3: the bodies; the (id, createdAt) pairs prune the monthly partitions
    const bodies = await select<BodyRow>(
      this.sequelize,
      `SELECT m.id, m."channelId", m.seq, m."authorId", m.body, m."replyToId", m."createdAt", m."deletedAt"
         FROM "ChatMessage" m
         JOIN unnest(ARRAY[:ids]::uuid[], ARRAY[:ats]::timestamptz[]) AS k(id, at) ON m.id = k.id AND m."createdAt" = k.at
        ORDER BY m."channelId", m.seq`,
      {
        ids: index.map((r) => r.messageId),
        ats: index.map((r) => r.createdAt),
      },
    );
    for (const b of bodies) {
      out.get(b.channelId)?.push({
        id: b.id,
        channelId: b.channelId,
        seq: safeNumber(b.seq),
        authorId: b.authorId,
        body: b.body,
        replyToId: b.replyToId,
        clientMessageId: null,
        createdAt: b.createdAt,
        deletedAt: b.deletedAt,
      });
    }
    return out;
  }
}
