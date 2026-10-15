import { Inject, Injectable } from '@nestjs/common';
import type {
  AssistantConversation,
  AssistantConversationList,
  AssistantHistory,
} from '@marketplace-sandbox/contracts';
import {
  CONVERSATION_REPOSITORY,
  type ConversationRecord,
  type ConversationRepository,
} from '../domain/assistant-ports';
import {
  decodeConversationCursor,
  encodeConversationCursor,
} from '../domain/conversation-cursor';
import {
  Domain_ConversationNotFound,
  Domain_InvalidCursor,
  Domain_TurnInProgress,
} from './assistant-errors';
import { GenerationService } from './generation.service';

const view = (c: ConversationRecord): AssistantConversation => ({
  id: c.conversationId,
  title: c.title,
  updatedAt: c.updatedAt.toISOString(),
  messageCount: c.messageCount ?? 0,
});

/** Create, list, read and delete a user's own conversations; the principal is in every lookup (S46 FR-010). */
@Injectable()
export class ConversationService {
  constructor(
    @Inject(CONVERSATION_REPOSITORY)
    private readonly conversations: ConversationRepository,
    private readonly generations: GenerationService,
  ) {}

  async create(userId: string, title: string): Promise<AssistantConversation> {
    return view(await this.conversations.create(userId, title));
  }

  async list(
    userId: string,
    query: { limit: number; cursor?: string },
  ): Promise<AssistantConversationList> {
    let after: string | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeConversationCursor(query.cursor);
      if (!decoded) throw new Domain_InvalidCursor();
      after = decoded;
    }
    const page = await this.conversations.list(userId, {
      limit: query.limit,
      after,
    });
    return {
      items: page.items.map(view),
      nextCursor: page.nextAfter
        ? encodeConversationCursor(page.nextAfter)
        : null,
    };
  }

  /** What the UI renders: text and which tools ran, never thinking, raw tool input or output, or the context line. */
  async history(
    userId: string,
    conversationId: string,
  ): Promise<AssistantHistory> {
    const conversation = await this.conversations.find(userId, conversationId);
    if (!conversation) throw new Domain_ConversationNotFound();
    const messages = await this.conversations.messages(userId, conversationId);
    return {
      conversation: {
        id: conversation.conversationId,
        title: conversation.title,
        updatedAt: conversation.updatedAt.toISOString(),
      },
      messages: messages
        .map((m) => ({
          id: m.messageId,
          turnId: m.turnId,
          role: m.role,
          text: m.visibleText,
          tools: m.toolNames,
        }))
        .filter((m) => m.text || m.tools.length),
    };
  }

  async remove(userId: string, conversationId: string): Promise<void> {
    if (!(await this.conversations.find(userId, conversationId)))
      throw new Domain_ConversationNotFound();
    // A reply being written holds the conversation; one whose generator is gone does not.
    if (!(await this.generations.reclaimLock(userId, conversationId)))
      throw new Domain_TurnInProgress();
    if (!(await this.conversations.remove(userId, conversationId)))
      throw new Domain_ConversationNotFound();
  }
}
