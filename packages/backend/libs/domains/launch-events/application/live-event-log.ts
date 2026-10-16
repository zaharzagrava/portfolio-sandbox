import { Injectable } from '@nestjs/common';
import { EventPublisher } from '@app/infrastructure/events/event-publisher';
import type { LiveComment } from '../domain/live-constants';
import {
  LiveCommentPosted,
  LiveCommentRemoved,
  LiveReactionsAggregated,
} from './events/live-events';

/** `0`↔`1`, … : a second valid UUIDv7 that is stable for a given one (a removal's event id derives from its comment's). */
const sibling = (uuid: string): string => {
  const last = uuid[uuid.length - 1];
  const next = ((parseInt(last, 16) + 1) % 16).toString(16);
  return uuid.slice(0, -1) + next;
};

/**
 * The high-volume `live.*` events on the plain producer (no relational transaction to be atomic with, S53). The event id
 * of a comment's events derives from the comment id, so a retry of the same publish is the same message.
 */
@Injectable()
export class LiveEventLog {
  constructor(private readonly publisher: EventPublisher) {}

  commentPosted(comment: LiveComment): Promise<void> {
    return this.publisher.publish({
      ...LiveCommentPosted.create(comment.streamId, 0, {
        streamId: comment.streamId,
        commentId: comment.id,
        authorId: comment.authorId,
        authorName: comment.authorName,
        text: comment.text,
        at: comment.at,
        ...(comment.priority && { priority: true as const }),
      }),
      eventId: comment.id,
    });
  }

  commentRemoved(input: {
    streamId: string;
    commentId: string;
    at: number;
    reason: 'moderator' | 'auto';
    actorId?: string;
    score?: number;
  }): Promise<void> {
    return this.publisher.publish({
      ...LiveCommentRemoved.create(input.streamId, 0, {
        streamId: input.streamId,
        commentId: input.commentId,
        at: input.at,
        reason: input.reason,
        ...(input.actorId && { actorId: input.actorId }),
        ...(input.score !== undefined && { score: input.score }),
      }),
      eventId: sibling(input.commentId),
    });
  }

  reactionsAggregated(
    streamId: string,
    second: number,
    reactions: Record<string, number>,
  ): Promise<void> {
    return this.publisher.publish(
      LiveReactionsAggregated.create(streamId, 0, {
        streamId,
        second,
        reactions,
      }),
    );
  }
}
