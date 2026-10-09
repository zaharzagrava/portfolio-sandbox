import { Injectable, NotFoundException } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { types } from 'cassandra-driver';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';

export interface ConversationRow {
  id: string;
  title: string;
  summary: string | null;
  compactedUpto: string | null;
  updatedAt: Date;
}

export interface StoredMessage {
  id: string;
  turnId: string;
  role: 'user' | 'assistant';
  content: Anthropic.Beta.BetaContentBlockParam[];
}

/** Hard cap per conversation - keeps the Scylla partition bounded (the UI offers "new chat"). */
export const MAX_MESSAGES = 400;

/**
 * Scylla-backed transcript (D24). Writes are appends; a whole tool round
 * (assistant tool_use + user tool_result) goes in one same-partition batch so
 * a crash can never persist a tool_use without its result (the next request
 * would be rejected).
 */
@Injectable()
export class ConversationStore {
  constructor(private readonly cassandra: CassandraService) {}

  async create(userId: string, title: string): Promise<ConversationRow> {
    const id = types.TimeUuid.now();
    const now = new Date();
    await this.cassandra.execute(
      `INSERT INTO assistant_conversations_by_user (user_id, conversation_id, title, updated_at) VALUES (?, ?, ?, ?)`,
      [userId, id, title, now],
    );
    return {
      id: id.toString(),
      title,
      summary: null,
      compactedUpto: null,
      updatedAt: now,
    };
  }

  async get(userId: string, conversationId: string): Promise<ConversationRow> {
    const res = await this.cassandra.execute(
      `SELECT conversation_id, title, summary, compacted_upto, updated_at FROM assistant_conversations_by_user WHERE user_id = ? AND conversation_id = ?`,
      [userId, conversationId],
    );
    const row = res.first();
    // Someone else's conversation looks exactly like a missing one.
    if (!row) throw new NotFoundException('Conversation not found');
    return this.toConversation(row);
  }

  async list(userId: string, limit = 20): Promise<ConversationRow[]> {
    const res = await this.cassandra.execute(
      `SELECT conversation_id, title, summary, compacted_upto, updated_at FROM assistant_conversations_by_user WHERE user_id = ? LIMIT ?`,
      [userId, limit],
    );
    return res.rows.map((r) => this.toConversation(r));
  }

  async messages(
    conversationId: string,
    after: string | null = null,
  ): Promise<StoredMessage[]> {
    const res = after
      ? await this.cassandra.execute(
          `SELECT * FROM assistant_messages_by_conversation WHERE conversation_id = ? AND message_id > ? LIMIT ?`,
          [conversationId, after, MAX_MESSAGES],
        )
      : await this.cassandra.execute(
          `SELECT * FROM assistant_messages_by_conversation WHERE conversation_id = ? LIMIT ?`,
          [conversationId, MAX_MESSAGES],
        );
    return res.rows.map((r) => ({
      id: (r.get('message_id') as types.TimeUuid).toString(),
      turnId: (r.get('turn_id') as types.TimeUuid).toString(),
      role: r.get('role'),
      content: JSON.parse(r.get('content')),
    }));
  }

  async count(conversationId: string): Promise<number> {
    const res = await this.cassandra.execute(
      `SELECT count(*) AS n FROM assistant_messages_by_conversation WHERE conversation_id = ?`,
      [conversationId],
    );
    return Number(res.first()?.get('n') ?? 0);
  }

  /** Appends in order; ids are time-UUIDs generated here so clustering order = append order. Returns the ids. */
  async append(
    conversationId: string,
    turnId: string,
    messages: Pick<StoredMessage, 'role' | 'content'>[],
  ): Promise<string[]> {
    const ids = messages.map(() => types.TimeUuid.now());
    await this.cassandra.batchSamePartition(
      messages.map((m, i) => ({
        query: `INSERT INTO assistant_messages_by_conversation (conversation_id, message_id, turn_id, role, content) VALUES (?, ?, ?, ?, ?)`,
        params: [
          conversationId,
          ids[i],
          turnId,
          m.role,
          JSON.stringify(m.content),
        ],
      })),
    );
    return ids.map((id) => id.toString());
  }

  async touch(userId: string, conversationId: string): Promise<void> {
    await this.cassandra.execute(
      `UPDATE assistant_conversations_by_user SET updated_at = ? WHERE user_id = ? AND conversation_id = ?`,
      [new Date(), userId, conversationId],
    );
  }

  async compact(
    userId: string,
    conversationId: string,
    summary: string,
    upto: string,
  ): Promise<void> {
    await this.cassandra.execute(
      `UPDATE assistant_conversations_by_user SET summary = ?, compacted_upto = ?, updated_at = ? WHERE user_id = ? AND conversation_id = ?`,
      [summary, upto, new Date(), userId, conversationId],
    );
  }

  private toConversation(row: types.Row): ConversationRow {
    return {
      id: (row.get('conversation_id') as types.TimeUuid).toString(),
      title: row.get('title'),
      summary: row.get('summary') ?? null,
      compactedUpto:
        (row.get('compacted_upto') as types.TimeUuid | null)?.toString() ??
        null,
      updatedAt: row.get('updated_at'),
    };
  }
}
