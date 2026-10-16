import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  createLiveStreamRequestSchema,
  type LiveStreamDto,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { fieldIssues } from '../domain/field-issues';
import {
  liveUnavailable,
  liveValidationFailed,
  LiveError,
  streamEnded,
  streamNotFound,
} from '../domain/live-errors';
import { streamTopic } from '../domain/live-keys';
import {
  ACTIVE_STREAM_SET,
  LIVE_STREAMS,
  type ActiveStreams,
  type LiveStreamRecord,
  type LiveStreamRepository,
} from '../domain/live-ports';
import { durationSeconds, liveTransition } from '../domain/live-state';
import { LiveStreamEnded, LiveStreamStarted } from './events/live-events';
import { toStreamDto } from './live-dto';
import { logLiveError, logLiveWarn } from './live-log';
import { LiveStateCache } from './live-state-cache';

/**
 * The stream's lifecycle (FR-001, FR-002, FR-005). Every move is one conditional update of the authoritative record with
 * its outbox event in the same transaction (a refused append leaves the status where it was); what viewers and the
 * statistics publisher see follows after the commit, and the stream state cache is dropped before anything is published.
 */
@Injectable()
export class LiveStreamService {
  private readonly logger = new Logger(LiveStreamService.name);

  constructor(
    @Inject(LIVE_STREAMS) private readonly streams: LiveStreamRepository,
    @Inject(ACTIVE_STREAM_SET) private readonly active: ActiveStreams,
    private readonly outbox: OutboxService,
    private readonly state: LiveStateCache,
    private readonly realtime: RealtimePublisher,
    private readonly tx: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(shopId: string, body: unknown): Promise<LiveStreamDto> {
    const parsed = createLiveStreamRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw liveValidationFailed(fieldIssues(parsed.error));
    const record = await this.streams.create({
      shopId,
      title: parsed.data.title,
      launchEventId: parsed.data.launchEventId ?? null,
    });
    return toStreamDto(record);
  }

  start(shopId: string, streamId: string): Promise<LiveStreamDto> {
    return this.move(shopId, streamId, 'LIVE');
  }

  end(shopId: string, streamId: string): Promise<LiveStreamDto> {
    return this.move(shopId, streamId, 'ENDED');
  }

  private async move(
    shopId: string,
    streamId: string,
    to: 'LIVE' | 'ENDED',
  ): Promise<LiveStreamDto> {
    // Two tries: the second one reads the winner of a race and answers from its result.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.streams.findById(streamId);
      if (!current || current.shopId !== shopId) throw streamNotFound();
      const verdict = liveTransition(current.status, to);
      if (verdict === 'noop') return toStreamDto(current);
      if (verdict === 'illegal') throw streamEnded();
      const moved = await this.commit(current, to);
      if (!moved) continue;
      await this.afterCommit(moved, to);
      return toStreamDto(moved);
    }
    throw liveUnavailable();
  }

  private async commit(
    current: LiveStreamRecord,
    to: 'LIVE' | 'ENDED',
  ): Promise<LiveStreamRecord | null> {
    const at = this.clock.now();
    try {
      return await this.tx.run(async () => {
        const moved = await this.streams.transition({
          id: current.id,
          shopId: current.shopId,
          from: current.status,
          to,
          at,
        });
        if (!moved) return null;
        await this.outbox.append(
          to === 'LIVE'
            ? LiveStreamStarted.create(moved.id, 1, {
                streamId: moved.id,
                shopId: moved.shopId,
                title: moved.title,
                launchEventId: moved.launchEventId,
                startedAt: at.toISOString(),
              })
            : LiveStreamEnded.create(moved.id, 2, {
                streamId: moved.id,
                shopId: moved.shopId,
                endedAt: at.toISOString(),
                durationSeconds: durationSeconds(moved.startedAt, at),
              }),
        );
        return moved;
      });
    } catch (error) {
      if (error instanceof LiveError) throw error;
      logLiveError(
        this.logger,
        'status_change_failed',
        { streamId: current.id },
        error,
      );
      throw liveUnavailable();
    }
  }

  private async afterCommit(
    moved: LiveStreamRecord,
    to: 'LIVE' | 'ENDED',
  ): Promise<void> {
    // Drop the cached state first: whoever reads after the publish below must see the new status.
    await this.state.evict(moved.id).catch(() => undefined);
    // The reconcile job repairs the set when this fails.
    await (
      to === 'LIVE' ? this.active.add(moved.id) : this.active.remove(moved.id)
    ).catch((error: Error) =>
      logLiveWarn(
        this.logger,
        'active_set_not_updated',
        { streamId: moved.id },
        error,
      ),
    );
    await this.realtime
      .publish(streamTopic(moved.id), 'status', { status: to })
      .catch((error: Error) =>
        logLiveWarn(
          this.logger,
          'status_not_published',
          { streamId: moved.id },
          error,
        ),
      );
  }
}
