import { Inject, Injectable, Logger } from '@nestjs/common';
import { reactRequestSchema } from '@marketplace-sandbox/contracts';
import { AppError } from '@app/common/errors';
import { CLOCK, Clock } from '@app/common/core/clock';
import { fieldIssues } from '../domain/field-issues';
import {
  liveUnavailable,
  liveValidationFailed,
  streamNotFound,
  streamNotLive,
} from '../domain/live-errors';
import type { Reaction } from '../domain/live-constants';
import { REACTION_COUNTERS, type ReactionCounters } from '../domain/live-ports';
import { LiveLimits } from './live-limits';
import { logLiveError } from './live-log';
import { liveMetrics } from './live-metrics';
import { LiveStateCache } from './live-state-cache';

/**
 * Reactions are counted, never forwarded (FR-029): one validated, all-or-nothing increment of the current second's
 * sharded counters. No relational query, no history write and no event on this path.
 */
@Injectable()
export class LiveReactionService {
  private readonly logger = new Logger(LiveReactionService.name);

  constructor(
    private readonly limits: LiveLimits,
    private readonly state: LiveStateCache,
    @Inject(REACTION_COUNTERS) private readonly counters: ReactionCounters,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async react(streamId: string, userId: string, body: unknown): Promise<void> {
    await this.limits.take('live.reaction', `user:${userId}`);
    const parsed = reactRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw liveValidationFailed(fieldIssues(parsed.error));
    const reactions = parsed.data.reactions as Partial<
      Record<Reaction, number>
    >;
    try {
      const stream = await this.state.get(streamId);
      if (!stream) throw streamNotFound();
      if (stream.status !== 'LIVE') throw streamNotLive();
      await this.counters.add(
        streamId,
        Math.floor(this.clock.nowMs() / 1000),
        reactions,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      logLiveError(this.logger, 'reaction_not_counted', { streamId }, error);
      throw liveUnavailable();
    }
    liveMetrics.reactions.add(
      Object.values(reactions).reduce((sum, n) => sum + (n ?? 0), 0),
    );
  }
}
