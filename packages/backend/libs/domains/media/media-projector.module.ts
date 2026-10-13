import { Module } from '@nestjs/common';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { MediaStore } from './domain/ports';
import {
  MediaProductDeletedProjector,
  MediaShopDeletedProjector,
} from './infra/media-consumers';
import { SequelizeMediaStore } from './infra/media-store';

/**
 * Photos, projector side (apps/projector): the two consumers of S29, `catalog.product_deleted` (drops the gallery) and
 * `tenancy.shop_deleted` (deletes the shop's photos and galleries). The app lists `MediaProjectorModule.projectors` in
 * `ProjectionsModule.forProjectors` and imports this module for what they inject. Both are idempotent by nature (the
 * second delivery finds nothing to change), so `idempotency` is `natural`. This module imports the database and the
 * clock only: no storage, no queue, no catalog or tenancy module (the S32 requirement that it loads in the projector).
 */
@Module({
  imports: [ClockModule],
  providers: [
    { provide: MediaStore, useClass: SequelizeMediaStore },
    MediaProductDeletedProjector,
    MediaShopDeletedProjector,
  ],
  // the consumer host (`ProjectionsModule.forProjectors`) resolves the projectors' own dependencies through these
  exports: [
    MediaProductDeletedProjector,
    MediaShopDeletedProjector,
    MediaStore,
    ClockModule,
  ],
})
export class MediaProjectorModule {
  static readonly projectors = [
    MediaProductDeletedProjector,
    MediaShopDeletedProjector,
  ];
}
