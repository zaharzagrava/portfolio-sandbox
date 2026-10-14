import { Inject, Injectable } from '@nestjs/common';
import type {
  ChatMessage,
  ChatMessagePage,
  SendMessageRequest,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ChatChannelMemberStatus } from '../domain/chat.constants';
import {
  banned,
  channelArchived,
  channelNotFound,
  ChatValidationError,
  idempotencyKeyReuse,
  muted,
  replyTargetInvalid,
} from '../domain/errors';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
} from '../domain/history-cursor';
import {
  PORTS,
  type MembershipRepository,
  type MessageRepository,
} from '../domain/ports';
import { ChatPublisher } from './chat-publisher';
import { toMessageView } from './chat-views';

export interface SendResult {
  message: ChatMessage;
  duplicate: boolean;
}

/** Messages: send exactly once (S24 US2) and read the history (US3). The single decision statement lives in the repository. */
@Injectable()
export class ChatMessageService {
  constructor(
    @Inject(PORTS.MessageRepository)
    private readonly messages: MessageRepository,
    @Inject(PORTS.MembershipRepository)
    private readonly members: MembershipRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly publisher: ChatPublisher,
  ) {}

  /**
   * Newest first by sequence in keyset pages (FR-023): tombstones included, an opaque cursor, the membership
   * predicate on every page. A stranger gets the same `404` as for an unknown channel, a banned member `403 banned`.
   */
  async history(
    userId: string,
    channelId: string,
    query: { limit: number; cursor?: string },
  ): Promise<ChatMessagePage> {
    let before: number | null = null;
    if (query.cursor !== undefined) {
      before = decodeHistoryCursor(query.cursor);
      if (before === null) throw new ChatValidationError(['cursor']);
    }
    const member = await this.members.find(channelId, userId);
    if (!member) throw channelNotFound();
    if (member.status === ChatChannelMemberStatus.BANNED) throw banned();
    const page = await this.messages.listPage(
      channelId,
      before,
      query.limit + 1,
    );
    const items = page.slice(0, query.limit);
    return {
      items: items.map(toMessageView),
      nextCursor:
        page.length > query.limit
          ? encodeHistoryCursor(items[items.length - 1].seq)
          : null,
    };
  }

  /**
   * `duplicate: false` for a new message (the caller answers `201`), `true` for an identical replay (`200`, no event,
   * no push). The same key with other content is `422 idempotency_key_reuse` and discloses nothing.
   */
  async send(
    userId: string,
    channelId: string,
    input: SendMessageRequest,
  ): Promise<SendResult> {
    const outcome = await this.messages.insertIfAllowed({
      channelId,
      authorId: userId,
      clientMessageId: input.clientMessageId,
      body: input.body,
      replyToId: input.replyToId ?? null,
      now: this.clock.now(),
    });
    switch (outcome.kind) {
      case 'created': {
        const message = toMessageView(outcome.message);
        // after the commit, best effort: the sync is the delivery guarantee (FR-013)
        await this.publisher.channel(
          channelId,
          {
            type: 'message',
            channelId,
            message: {
              id: message.id,
              channelId,
              authorId: message.authorId,
              body: message.body,
              replyToId: message.replyToId,
              createdAt: message.createdAt,
              seq: message.seq,
            },
            seq: message.seq,
          },
          'message',
        );
        return { message, duplicate: false };
      }
      case 'replay':
        if (!outcome.sameContent) throw idempotencyKeyReuse();
        return { message: toMessageView(outcome.message), duplicate: true };
      case 'refused':
        switch (outcome.reason) {
          case 'not_found':
            throw channelNotFound();
          case 'banned':
            throw banned();
          case 'archived':
            throw channelArchived();
          case 'muted':
            throw muted(outcome.mutedUntil!);
          case 'reply_target_invalid':
            throw replyTargetInvalid();
        }
    }
  }
}
