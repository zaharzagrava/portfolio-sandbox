import { Injectable } from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import type {
  ConversationPage,
  ConversationRecord,
  ConversationRepository,
  MessageRecord,
  NewMessage,
} from '../domain/assistant-ports';

/** Hard cap per conversation (partition bound); the service refuses a send that could not fit a maximal turn. */
export const MAX_MESSAGES = 400;

const CONVERSATION_COLUMNS =
  'conversation_id, title, summary, compacted_upto, updated_at, message_count';

/**
 * Scylla-backed conversations and transcript (S46 data-model.md). The user id is in every key: the conversation row's
 * partition and the transcript's partition `(user_id, conversation_id)`, so another user's id is a plain miss (G2).
 * A turn's messages go in one same-partition batch.
 */
@Injectable()
export class ScyllaConversationRepository implements ConversationRepository {
  constructor(private readonly cassandra: CassandraService) {}

  async create(userId: string, title: string): Promise<ConversationRecord> {
    const id = types.TimeUuid.now();
    const now = new Date();
    await this.cassandra.execute(
      `INSERT INTO assistant_conversations_by_user (user_id, conversation_id, title, updated_at, message_count) VALUES (?, ?, ?, ?, 0)`,
      [userId, id, title, now],
    );
    return {
      userId,
      conversationId: id.toString(),
      title,
      updatedAt: now,
      messageCount: 0,
      summary: null,
      compactedUpTo: null,
    };
  }

  async find(
    userId: string,
    conversationId: string,
  ): Promise<ConversationRecord | null> {
    const res = await this.cassandra.execute(
      `SELECT ${CONVERSATION_COLUMNS} FROM assistant_conversations_by_user WHERE user_id = ? AND conversation_id = ?`,
      [userId, conversationId],
    );
    const row = res.first();
    return row ? this.toConversation(userId, row) : null;
  }

  async list(
    userId: string,
    page: { limit: number; after?: string },
  ): Promise<ConversationPage> {
    // Clustering order is newest first, so "after" the cursor means a smaller time-UUID.
    const res = page.after
      ? await this.cassandra.execute(
          `SELECT ${CONVERSATION_COLUMNS} FROM assistant_conversations_by_user WHERE user_id = ? AND conversation_id < ? LIMIT ?`,
          [userId, page.after, page.limit + 1],
        )
      : await this.cassandra.execute(
          `SELECT ${CONVERSATION_COLUMNS} FROM assistant_conversations_by_user WHERE user_id = ? LIMIT ?`,
          [userId, page.limit + 1],
        );
    const items = res.rows
      .slice(0, page.limit)
      .map((row) => this.toConversation(userId, row));
    const more = res.rows.length > page.limit;
    return {
      items,
      nextAfter: more ? items[items.length - 1].conversationId : undefined,
    };
  }

  async rename(
    userId: string,
    conversationId: string,
    title: string,
  ): Promise<boolean> {
    if (!(await this.find(userId, conversationId))) return false;
    await this.cassandra.execute(
      `UPDATE assistant_conversations_by_user SET title = ? WHERE user_id = ? AND conversation_id = ?`,
      [title, userId, conversationId],
    );
    return true;
  }

  async remove(userId: string, conversationId: string): Promise<boolean> {
    if (!(await this.find(userId, conversationId))) return false;
    await this.cassandra.execute(
      `DELETE FROM assistant_messages_by_user_conversation WHERE user_id = ? AND conversation_id = ?`,
      [userId, conversationId],
    );
    await this.cassandra.execute(
      `DELETE FROM assistant_conversations_by_user WHERE user_id = ? AND conversation_id = ?`,
      [userId, conversationId],
    );
    return true;
  }

  async messages(
    userId: string,
    conversationId: string,
    options: { afterMessageId?: string } = {},
  ): Promise<MessageRecord[]> {
    const columns =
      'message_id, turn_id, role, content, visible_text, tool_names';
    const res = options.afterMessageId
      ? await this.cassandra.execute(
          `SELECT ${columns} FROM assistant_messages_by_user_conversation WHERE user_id = ? AND conversation_id = ? AND message_id > ? LIMIT ?`,
          [userId, conversationId, options.afterMessageId, MAX_MESSAGES],
        )
      : await this.cassandra.execute(
          `SELECT ${columns} FROM assistant_messages_by_user_conversation WHERE user_id = ? AND conversation_id = ? LIMIT ?`,
          [userId, conversationId, MAX_MESSAGES],
        );
    return res.rows.map((row) => ({
      messageId: (row.get('message_id') as types.TimeUuid).toString(),
      turnId: (row.get('turn_id') as types.TimeUuid).toString(),
      role: row.get('role'),
      content: row.get('content'),
      visibleText: row.get('visible_text') ?? '',
      toolNames: row.get('tool_names') ?? [],
    }));
  }

  async messageCount(userId: string, conversationId: string): Promise<number> {
    const res = await this.cassandra.execute(
      `SELECT message_count FROM assistant_conversations_by_user WHERE user_id = ? AND conversation_id = ?`,
      [userId, conversationId],
    );
    const stored = res.first()?.get('message_count') as
      number | null | undefined;
    if (stored !== null && stored !== undefined) return stored;
    // Lazy backfill (a row that predates the column): count once, then set it only while it is still empty.
    const counted = await this.cassandra.execute(
      `SELECT count(*) AS n FROM assistant_messages_by_user_conversation WHERE user_id = ? AND conversation_id = ?`,
      [userId, conversationId],
    );
    const n = Number(counted.first()?.get('n') ?? 0);
    await this.cassandra.execute(
      `UPDATE assistant_conversations_by_user SET message_count = ? WHERE user_id = ? AND conversation_id = ? IF message_count = null`,
      [n, userId, conversationId],
      { idempotent: false },
    );
    const again = await this.cassandra.execute(
      `SELECT message_count FROM assistant_conversations_by_user WHERE user_id = ? AND conversation_id = ?`,
      [userId, conversationId],
    );
    return Number(again.first()?.get('message_count') ?? n);
  }

  async appendTurn(
    userId: string,
    conversationId: string,
    turnId: string,
    messages: NewMessage[],
  ): Promise<void> {
    // The count is read first (and backfilled if empty); the reply lock makes this conversation single-writer.
    const before = await this.messageCount(userId, conversationId);
    const ids = messages.map(() => types.TimeUuid.now());
    await this.cassandra.batchSamePartition(
      messages.map((m, i) => ({
        query: `INSERT INTO assistant_messages_by_user_conversation (user_id, conversation_id, message_id, turn_id, role, content, visible_text, tool_names) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          userId,
          conversationId,
          ids[i],
          turnId,
          m.role,
          m.content,
          m.visibleText,
          m.toolNames,
        ],
      })),
    );
    await this.cassandra.execute(
      `UPDATE assistant_conversations_by_user SET message_count = ?, updated_at = ? WHERE user_id = ? AND conversation_id = ?`,
      [before + messages.length, new Date(), userId, conversationId],
    );
  }

  async recordCompaction(
    userId: string,
    conversationId: string,
    summary: string,
    upToMessageId: string,
  ): Promise<boolean> {
    const update = (condition: string) =>
      this.cassandra.execute(
        `UPDATE assistant_conversations_by_user SET summary = ?, compacted_upto = ? WHERE user_id = ? AND conversation_id = ? IF ${condition}`,
        [
          summary,
          upToMessageId,
          userId,
          conversationId,
          ...(condition.includes('?') ? [upToMessageId] : []),
        ],
        { idempotent: false },
      );
    // The marker only moves forward: first the empty case, then "older than the new marker".
    if ((await update('compacted_upto = null')).wasApplied()) return true;
    return (await update('compacted_upto < ?')).wasApplied();
  }

  private toConversation(userId: string, row: types.Row): ConversationRecord {
    return {
      userId,
      conversationId: (row.get('conversation_id') as types.TimeUuid).toString(),
      title: row.get('title'),
      updatedAt: row.get('updated_at'),
      messageCount: row.get('message_count') ?? null,
      summary: row.get('summary') ?? null,
      compactedUpTo:
        (row.get('compacted_upto') as types.TimeUuid | null)?.toString() ??
        null,
    };
  }
}
