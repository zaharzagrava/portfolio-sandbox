import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@app/common/errors';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import {
  PermanentError,
  TransientError,
} from '@app/infrastructure/projections/errors';
import { LiveCommentPosted } from '../application/events/live-events';
import { liveMetrics } from '../application/live-metrics';
import { LiveRemovalService } from '../application/live-removal.service';
import {
  CLASSIFIER_ATTEMPTS,
  CLASSIFIER_TIMEOUT_MS,
  LIVE_CONSUMER_MODERATION,
} from '../domain/live-constants';
import {
  LIVE_SETTINGS,
  TOXICITY_CLASSIFIER,
  type LiveSettings,
  type ToxicityClassifier,
} from '../domain/live-ports';

/**
 * Async moderation (10/06 #15): comments are shown first, scored after; the few that fail are retracted within ~1 s.
 * Its own consumer group, so a slow classifier never delays history writes. The classifier is asked with a 2-second
 * timeout; a failure is a `PermanentError` (the framework retries the event up to its attempt budget, then dead-letters
 * it, and the comment stays visible); a removal that cannot be made durable right now is `Transient` (the partition
 * pauses and the event is tried again, never dropped).
 */
@Injectable()
export class LiveModerationConsumer implements Projector {
  readonly name = LIVE_CONSUMER_MODERATION;
  readonly topics = [LiveCommentPosted.topic];
  // A removal is claimed per comment id, so a repeat of the same event produces no second removal.
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: LiveCommentPosted }];
  readonly attempts = CLASSIFIER_ATTEMPTS;

  constructor(
    private readonly removals: LiveRemovalService,
    @Inject(TOXICITY_CLASSIFIER)
    private readonly classifier: ToxicityClassifier,
    @Inject(LIVE_SETTINGS) private readonly settings: LiveSettings,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const envelope of events) {
      const posted = LiveCommentPosted.match(envelope);
      if (!posted) continue;
      const { streamId, commentId, text } = posted.payload;
      const score = await this.score(text);
      if (score < this.settings.moderationThreshold) continue;
      try {
        await this.removals.removeAuto(streamId, commentId, score);
      } catch (error) {
        liveMetrics.consumerFailures.add(1, { consumer: this.name });
        if (error instanceof AppError && Number(error.status) === 503)
          throw new TransientError('removal not durable yet', { cause: error });
        throw error;
      }
    }
  }

  private async score(text: string): Promise<number> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('classifier timed out')),
          CLASSIFIER_TIMEOUT_MS,
        );
      });
      const scored = this.classifier.score(text);
      scored.catch(() => undefined);
      return await Promise.race([scored, timeout]);
    } catch (error) {
      liveMetrics.moderationFailed.add(1);
      liveMetrics.consumerFailures.add(1, { consumer: this.name });
      throw new PermanentError('classifier failed', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
