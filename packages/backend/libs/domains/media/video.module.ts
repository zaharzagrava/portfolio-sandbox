import { Module } from '@nestjs/common';
import { ApiConfigModule, ApiConfigService } from '@app/common/config';
import { ProblemCatalogModule } from '@app/common/errors';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { AuthModule } from '@app/domains/identity';
import { ProductModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { DeliveryEdgeModule } from '@app/infrastructure/delivery-edge';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { VideoController } from './api/video.controller';
import { VideoPlaybackController } from './api/video-playback.controller';
import { VideoFinalizeService } from './application/video-finalize.service';
import { VideoManageService } from './application/video-manage.service';
import { VideoPlaybackService } from './application/video-playback.service';
import { VideoUploadService } from './application/video-upload.service';
import { VIDEO_PROBLEMS } from './domain/video-errors';
import { VideoLogger, VideoMetrics, VideoStore } from './domain/video-ports';
import {
  NestVideoLogger,
  RegistryVideoMetrics,
} from './infra/video-observability';
import { SequelizeVideoStore } from './infra/video-store';
import { PART_SIZE } from './domain/video-limits';
import {
  VIDEO_COOKIE_DOMAIN,
  VIDEO_ORIGIN,
  VIDEO_PART_SIZE,
} from './video.constants';
import { videoRatePolicies } from './video-rate-limit-policies';

/**
 * Product videos, core side (S30): upload, management and delivery routes. The transcoding itself runs in
 * `VideoWorkerModule` (apps/worker), the three event consumers in `VideoProjectorModule`. `media` reads no table of
 * another domain: the product check is catalog R1, membership and the shop gate are tenancy's, the shop's suspension is
 * a local copy kept by event (`VideoShopState`).
 */
@Module({
  imports: [
    ApiConfigModule,
    AuthModule,
    ProductModule,
    TenancyModule,
    StorageModule,
    SqsModule,
    DeliveryEdgeModule,
    ErrorUtilsModule, // for `VideoHiddenShopFilter`, which delegates to the platform filter
    ProblemCatalogModule.forFeature(VIDEO_PROBLEMS),
    RateLimitModule.forFeature(videoRatePolicies),
  ],
  providers: [
    { provide: VideoStore, useClass: SequelizeVideoStore },
    { provide: VideoMetrics, useClass: RegistryVideoMetrics },
    { provide: VideoLogger, useClass: NestVideoLogger },
    {
      provide: VIDEO_ORIGIN,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService): string => {
        // No fallback to the storage endpoint or the photo origin: a missing host must not silently expose the bucket.
        const origin = config.get('video_cdn_url');
        if (!origin)
          throw new Error(
            'video_cdn_url is required (the host every video URL is built on)',
          );
        return origin;
      },
    },
    {
      provide: VIDEO_COOKIE_DOMAIN,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService): string | null =>
        config.get('video_cookie_domain') ?? null,
    },
    { provide: VIDEO_PART_SIZE, useValue: { value: PART_SIZE } },
    VideoFinalizeService,
    VideoUploadService,
    VideoManageService,
    VideoPlaybackService,
  ],
  controllers: [VideoController, VideoPlaybackController],
})
export class VideoModule {}
