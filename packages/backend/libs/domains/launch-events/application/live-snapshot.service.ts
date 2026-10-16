import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LiveSnapshotDto } from '@marketplace-sandbox/contracts';
import { streamNotFound } from '../domain/live-errors';
import {
  RECENT_COMMENT_STORE,
  type RecentCommentStore,
} from '../domain/live-ports';
import { toSnapshotBase } from './live-dto';
import { logLiveWarn } from './live-log';
import { LiveLimits } from './live-limits';
import { LiveStateCache, type LiveStreamState } from './live-state-cache';

/**
 * What a viewer sees when it opens a stream: the record (from the cached state, one shared refill however many readers
 * arrive) and the last 50 comments. When the fast store is down the answer still comes from the authoritative record,
 * with no recent comments and `degraded: true` (FR-045, AS-51).
 */
@Injectable()
export class LiveSnapshotService {
  private readonly logger = new Logger(LiveSnapshotService.name);

  constructor(
    private readonly limits: LiveLimits,
    private readonly state: LiveStateCache,
    @Inject(RECENT_COMMENT_STORE) private readonly recent: RecentCommentStore,
  ) {}

  /** The public route: limited per address, fail open. */
  async read(streamId: string, address: string): Promise<LiveSnapshotDto> {
    await this.limits.take('live.snapshot.ip', `ip:${address}`);
    const stream = await this.state.get(streamId);
    if (!stream) throw streamNotFound();
    return this.compose(stream);
  }

  /** The state of a stream for the event connection's first frame; `null` for an unknown stream. */
  stateOf(streamId: string): Promise<LiveStreamState | null> {
    return this.state.get(streamId);
  }

  async compose(stream: LiveStreamState): Promise<LiveSnapshotDto> {
    try {
      return {
        ...toSnapshotBase(stream),
        recent: await this.recent.list(stream.id),
      };
    } catch (error) {
      logLiveWarn(
        this.logger,
        'recent_unavailable',
        { streamId: stream.id },
        error,
      );
      return { ...toSnapshotBase(stream), recent: [], degraded: true };
    }
  }
}
