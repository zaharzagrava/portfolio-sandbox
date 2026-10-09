import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { VIDEO_QUEUE, VideoService } from './application/video.service';
import { VideoController } from './api/video.controller';

/** SD-26 API (core). */
@Module({
  imports: [AuthModule, StorageModule, SqsModule],
  providers: [VideoService],
  exports: [VideoService],
  controllers: [VideoController],
})
export class VideoModule {}

/**
 * Transcoding workers (apps/worker, on CPU-heavy spot instances in AWS; not
 * Lambda - a 1080p rendition of a long video runs past 15 min). Concurrency 2
 * per instance: ffmpeg already uses every core. AWS Elemental MediaConvert is
 * the managed alternative (ADR in the section doc).
 */
@Injectable()
class VideoWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(VideoWorker.name);
  private readonly abort = new AbortController();
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly videos: VideoService,
  ) {}

  onApplicationBootstrap() {
    this.stop = this.queue.consume<{ videoId: string; task: string }>(
      VIDEO_QUEUE,
      async ({ body }) =>
        void (await this.videos.runTask(
          body.videoId,
          body.task,
          this.abort.signal,
        )),
      {
        concurrency: 2,
        visibilityTimeoutSec: 900,
      },
    );
  }

  async onModuleDestroy() {
    this.abort.abort(); // kills running ffmpeg; the task is re-queued and redelivered
    await this.stop?.();
  }
}

@Module({
  imports: [StorageModule, SqsModule],
  providers: [VideoService, VideoWorker],
})
export class VideoWorkerModule {}
