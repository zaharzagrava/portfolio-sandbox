import { Module } from '@nestjs/common';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { VideoStore } from './domain/video-ports';
import {
  VideoProductDeletedProjector,
  VideoShopDeletedProjector,
  VideoShopStatusProjector,
} from './infra/video-consumers';
import { SequelizeVideoStore } from './infra/video-store';

/**
 * Product videos, projector side (apps/projector): the three consumers of S30. The app lists
 * `VideoProjectorModule.projectors` in `ProjectionsModule.forProjectors` and imports this module for what they inject.
 * This module imports the database and the clock only: no storage, no queue, no catalog or tenancy module (the S32
 * requirement that it loads in the projector).
 */
@Module({
  imports: [ClockModule],
  providers: [
    { provide: VideoStore, useClass: SequelizeVideoStore },
    VideoProductDeletedProjector,
    VideoShopDeletedProjector,
    VideoShopStatusProjector,
  ],
  exports: [
    VideoProductDeletedProjector,
    VideoShopDeletedProjector,
    VideoShopStatusProjector,
    VideoStore,
    ClockModule,
  ],
})
export class VideoProjectorModule {
  static readonly projectors = [
    VideoProductDeletedProjector,
    VideoShopDeletedProjector,
    VideoShopStatusProjector,
  ];
}
