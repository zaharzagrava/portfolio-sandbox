import { Module } from '@nestjs/common';
import { ApiConfigModule, ApiConfigService } from '@app/common/config';
import { ProblemCatalogModule } from '@app/common/errors';
import { AuthModule } from '@app/domains/identity';
import { ProductModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { BatchController } from './api/batch.controller';
import { GalleryController } from './api/gallery.controller';
import { MediaController } from './api/media.controller';
import { GalleryService } from './application/gallery.service';
import { MediaDeleteService } from './application/media-delete.service';
import { MediaQueryService } from './application/media-query.service';
import { MediaReadService } from './application/media-read.service';
import { UploadService } from './application/upload.service';
import { MEDIA_PROBLEMS } from './domain/media-errors';
import { MediaStore } from './domain/ports';
import { SequelizeMediaStore } from './infra/media-store';
import { MEDIA_ORIGIN } from './media.constants';
import { mediaRatePolicies } from './rate-limit-policies';

/**
 * Photos, core side (S29): upload, read, batch, delete and gallery routes, and `MediaQueryService` (R1). The processing
 * itself runs in the `media-processing` Lambda (`createMediaProcessor`), the jobs in `MediaWorkerModule`, the two event
 * consumers in `MediaProjectorModule`. `media` reads no table of another domain: products come from catalog R1, shops
 * and membership from tenancy R1.
 */
@Module({
  imports: [
    ApiConfigModule,
    AuthModule,
    ProductModule,
    TenancyModule,
    StorageModule,
    SqsModule,
    ProblemCatalogModule.forFeature(MEDIA_PROBLEMS),
    RateLimitModule.forFeature(mediaRatePolicies),
  ],
  providers: [
    { provide: MediaStore, useClass: SequelizeMediaStore },
    {
      provide: MEDIA_ORIGIN,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService): string => {
        // No fallback to the storage endpoint: a missing origin must not silently expose the bucket (A8).
        const origin = config.get('media_cdn_url');
        if (!origin)
          throw new Error(
            'media_cdn_url is required (the media origin photo URLs are built on)',
          );
        return origin;
      },
    },
    UploadService,
    MediaReadService,
    MediaQueryService,
    MediaDeleteService,
    GalleryService,
  ],
  controllers: [MediaController, GalleryController, BatchController],
  exports: [MediaQueryService],
})
export class MediaModule {}
