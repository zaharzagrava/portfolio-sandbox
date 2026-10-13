import {
  BeforeApplicationShutdown,
  Injectable,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';
import { DeliveryEdgeModule } from '@app/infrastructure/delivery-edge';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { VideoFinalizeService } from './application/video-finalize.service';
import { VideoLifecycleService } from './application/video-lifecycle.service';
import { VideoPipelineService } from './application/video-pipeline.service';
import { VideoPurgeService } from './application/video-purge.service';
import { VideoSweepService } from './application/video-sweep.service';
import { VideoTaskRunner } from './application/video-task-runner';
import { SQS_VISIBILITY_SEC, taskTimeoutMs } from './domain/task-limits';
import {
  TranscoderPort,
  VideoLogger,
  VideoMetrics,
  VideoStore,
} from './domain/video-ports';
import { FfmpegTranscoder } from './infra/ffmpeg-transcoder';
import {
  NestVideoLogger,
  RegistryVideoMetrics,
} from './infra/video-observability';
import { SequelizeVideoStore } from './infra/video-store';
import { VideoMaintenanceJobs } from './video-maintenance.jobs';
import {
  VIDEO_QUEUE,
  VIDEO_TASK_LIMITS,
  type VideoTaskMessage,
} from './video.constants';

/** A body that is not this goes to the dead-letter queue at once (S30 contracts/events.md, "Queue"). */
export const videoTaskMessageSchema = z.strictObject({
  videoId: z.uuid(),
  task: z
    .string()
    .regex(/^(probe|poster|thumbnails|package|publish|transcode:\d{3,4})$/),
});

/**
 * Consumes `video-transcode` (apps/worker, on CPU-heavy long-lived instances; not Lambda: a 1080p rendition of a long
 * video runs past 15 minutes). Concurrency 2 per instance: ffmpeg already uses every core. On shutdown it stops taking
 * messages and aborts the running tasks: their encoders are killed and the tasks go back to `QUEUED` without an
 * attempt (S30 R-22); Nest closes the database pool after this hook.
 */
@Injectable()
export class VideoTaskConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly abort = new AbortController();
  private stop?: () => Promise<void>;
  /** Runs in progress: shutdown waits for them to give their tasks back before the pools close. */
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly queue: TaskQueue,
    private readonly pipeline: VideoPipelineService,
  ) {}

  onApplicationBootstrap(): void {
    this.stop = this.queue.consume<VideoTaskMessage>(
      VIDEO_QUEUE,
      async (message) => {
        const run = this.pipeline.handle(
          {
            body: message.body,
            receiveCount: message.receiveCount,
            attributes: message.attributes,
          },
          this.abort.signal,
        );
        this.inflight.add(run);
        try {
          await run;
        } finally {
          this.inflight.delete(run);
        }
      },
      {
        concurrency: 2,
        visibilityTimeoutSec: SQS_VISIBILITY_SEC,
        bodySchema: videoTaskMessageSchema,
      },
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort(); // kills the encoders; each run re-queues its task without an attempt
    await this.stop?.();
    // The whole shutdown has 30 s (AS-62): wait for the runs to finish giving their tasks back, no longer than 25 s.
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise((resolve) => setTimeout(resolve, 25_000).unref()),
    ]);
  }
}

/** Transcoding workers, worker side (S30): the task consumer. The maintenance jobs join it with the lifecycle work. */
@Module({
  imports: [
    ClockModule,
    StorageModule,
    SqsModule,
    JobsModule,
    DeliveryEdgeModule,
  ],
  providers: [
    { provide: VideoStore, useClass: SequelizeVideoStore },
    { provide: VideoMetrics, useClass: RegistryVideoMetrics },
    { provide: VideoLogger, useClass: NestVideoLogger },
    { provide: TranscoderPort, useClass: FfmpegTranscoder },
    { provide: VIDEO_TASK_LIMITS, useValue: { timeoutMs: taskTimeoutMs } },
    VideoTaskRunner,
    VideoPipelineService,
    VideoTaskConsumer,
    VideoFinalizeService,
    VideoLifecycleService,
    VideoSweepService,
    VideoPurgeService,
    VideoMaintenanceJobs,
  ],
})
export class VideoWorkerModule {}
