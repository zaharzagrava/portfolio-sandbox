import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  PROCESSING_LIMIT_MS,
  STUCK_RESEND_GUARD_MS,
} from '../domain/task-limits';
import { VideoMetrics, VideoStore } from '../domain/video-ports';
import { VIDEO_QUEUE } from '../video.constants';
import { VideoFinalizeService } from './video-finalize.service';
import { JOB_BATCH } from './video-lifecycle.service';
import { messageAttributes } from './video-messages';

/** A `QUEUED` task or an `UPLOADED` video untouched this long lost its message or its worker (S30 AS-50). */
const STUCK_AFTER_MS = 5 * 60 * 1000;

const SYSTEM = { type: 'system' } as const;

/**
 * `media.video-requeue-stuck` (S30 B12, AS-50, AS-51): finds work that stopped without anyone noticing and starts it
 * again, once per sweep. (a) a `RUNNING` task whose lease ran out goes back to `QUEUED` with a message; (b) a `QUEUED`
 * task untouched for 5 minutes gets a message again (only while it was not sent in the last minute, so repeated and
 * concurrent sweeps add none); (c) an `UPLOADED` video older than 5 minutes is driven on to `PROCESSING`; (d) a
 * `PROCESSING` video with nothing running whose fan-in was lost gets its next tasks queued; (e) a video in
 * `PROCESSING` for over 6 hours fails as `processing_timeout`. Every step is a conditional update, so a duplicate
 * delivery that follows is a no-op for the pipeline (AS-22).
 */
@Injectable()
export class VideoSweepService {
  private readonly logger = new Logger(VideoSweepService.name);

  constructor(
    private readonly store: VideoStore,
    private readonly finalizer: VideoFinalizeService,
    private readonly queue: TaskQueue,
    private readonly metrics: VideoMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async sweep(): Promise<Record<string, number>> {
    const recovered = {
      lease: 0,
      queued: 0,
      uploaded: 0,
      fanin: 0,
      timeout: 0,
    };
    const now = this.clock.now();
    const recover = (kind: keyof typeof recovered, by = 1) => {
      recovered[kind] += by;
      this.metrics.inc('video_stuck_recovered_total', { kind }, by);
    };

    // (a) a worker died holding the lease
    for (const { videoId, name } of await this.store.tasks.listLeaseExpired(
      now,
      JOB_BATCH,
    )) {
      const released = await this.store.tx(async ({ video, tasks }) => {
        await video.lock(videoId);
        return tasks.releaseExpired(videoId, name, now);
      });
      if (released) {
        await this.send(videoId, name);
        recover('lease');
      }
    }

    // (b) the message was lost between the commit and the send
    for (const { videoId, name } of await this.store.tasks.listQueuedStale({
      before: new Date(now.getTime() - STUCK_AFTER_MS),
      sentBefore: new Date(now.getTime() - STUCK_RESEND_GUARD_MS),
      limit: JOB_BATCH,
    })) {
      const mine = await this.store.tasks.claimResend({
        videoId,
        name,
        now,
        sentBefore: new Date(now.getTime() - STUCK_RESEND_GUARD_MS),
      });
      if (mine) {
        await this.send(videoId, name);
        recover('queued');
      }
    }

    // (c) a crash after the claim left the upload assembled or half assembled
    for (const video of await this.store.video.listStuckUploaded(
      new Date(now.getTime() - STUCK_AFTER_MS),
      JOB_BATCH,
    )) {
      try {
        const answer = await this.finalizer.finalize(video, null, null);
        if (answer.status === 'PROCESSING') recover('uploaded');
      } catch (error) {
        this.logger.warn(
          `could not drive an upload on: ${(error as Error).message}`,
          undefined,
          { videoId: video.id },
        );
      }
    }

    // (d) every task is done but the last fan-in never queued the next one
    for (const videoId of await this.store.tasks.listIdleProcessing(
      JOB_BATCH,
    )) {
      const ready = await this.store.tx(async ({ video, tasks }) => {
        await video.lock(videoId);
        return tasks.dispatchReady(videoId, now);
      });
      for (const name of ready) await this.send(videoId, name);
      if (ready.length) recover('fanin', ready.length);
    }

    // (e) a video that cannot finish fails clearly instead of hanging
    for (const video of await this.store.video.listProcessingSince(
      new Date(now.getTime() - PROCESSING_LIMIT_MS),
      JOB_BATCH,
    )) {
      const failed = await this.store.tx(({ video: repo }) =>
        repo.fail({
          id: video.id,
          from: ['PROCESSING'],
          code: 'processing_timeout',
          internalError: 'the video was processing for more than 6 hours',
          actor: SYSTEM,
          now,
        }),
      );
      if (failed) {
        this.metrics.inc('video_status_transitions_total', {
          from: 'PROCESSING',
          to: 'FAILED',
        });
        recover('timeout');
      }
    }
    return recovered;
  }

  private async send(videoId: string, task: string): Promise<void> {
    try {
      await this.queue.enqueue(
        VIDEO_QUEUE,
        { videoId, task },
        { attributes: messageAttributes(this.clock) },
      );
    } catch (error) {
      this.logger.error(
        `could not enqueue ${task}; the next sweep will: ${(error as Error).message}`,
        undefined,
        { videoId },
      );
    }
  }
}
