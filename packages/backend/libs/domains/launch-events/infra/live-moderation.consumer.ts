import { Injectable, Optional } from '@nestjs/common';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { LiveCommentPosted } from '../application/events/live-events';
import {
  HeuristicToxicityClassifier,
  ToxicityClassifier,
} from '../domain/moderation';
import { LiveService } from '../application/live.service';

const REMOVE_AT = 0.7;

/**
 * Async moderation (10/06 #15): comments are shown first, scored after; the
 * few that fail are retracted with a `comment_removed` event within ~1 s.
 * Its own consumer group, so a slow classifier never delays history writes.
 */
@Injectable()
export class LiveModerationConsumer implements Projector {
  readonly name = 'live-moderation';
  readonly topics = [LiveCommentPosted.topic];
  // Scoring is deterministic and a removal is keyed by comment id, so a repeat produces the same removal.
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: LiveCommentPosted }];
  private readonly classifier: ToxicityClassifier;

  constructor(
    private readonly live: LiveService,
    @Optional() classifier?: ToxicityClassifier,
  ) {
    this.classifier = classifier ?? new HeuristicToxicityClassifier();
  }

  async project(events: EventEnvelope[]): Promise<void> {
    const comments = events
      .map((e) => LiveCommentPosted.match(e))
      .filter((e): e is NonNullable<typeof e> => !!e);
    const scores = await Promise.all(
      comments.map((c) => this.classifier.score(c.payload.text)),
    );
    for (const [i, c] of comments.entries()) {
      if (scores[i] >= REMOVE_AT)
        await this.live.remove(
          c.payload.streamId,
          c.payload.commentId,
          `auto:${scores[i].toFixed(2)}`,
        );
    }
  }
}
