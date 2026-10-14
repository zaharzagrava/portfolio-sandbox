import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ORDERS_AGGREGATE } from './application/events/order-events';
import {
  FLASH_CRASH_POINT,
  FLASH_FAST_STORE,
  FLASH_RANDOM,
  FLASH_RESERVATION,
  FLASH_SALE_DIRECTORY,
  FLASH_SALE_REPOSITORY,
  type CrashPoint,
} from './domain/flash-ports';
import { FlashReservationSource } from './application/flash-reservation.source';
import { FlashSoldOutService } from './application/flash-sold-out.service';
import { RedisFlashFastStore } from './infra/flash-fast-store.redis';
import { CachedFlashSaleDirectory } from './infra/flash-sale.directory';
import { SequelizeFlashSaleRepository } from './infra/flash-sale.repository';

const noCrash: CrashPoint = { hit: () => undefined };

/**
 * The ports of the flash-sale feature and their adapters (S11 D-6). Imported by `OrdersCoreModule`, so S10's checkout,
 * release and conversion services can reach the `FLASH_RESERVATION` seam in both apps. The domain barrel exports none
 * of it. The lifecycle service and the routes live in `FlashSaleModule` / `FlashSaleWorkerModule`.
 */
@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    EventsModule.forAggregates([ORDERS_AGGREGATE]),
  ],
  providers: [
    { provide: FLASH_SALE_REPOSITORY, useClass: SequelizeFlashSaleRepository },
    { provide: FLASH_FAST_STORE, useClass: RedisFlashFastStore },
    { provide: FLASH_SALE_DIRECTORY, useClass: CachedFlashSaleDirectory },
    { provide: FLASH_RANDOM, useValue: Math.random },
    { provide: FLASH_CRASH_POINT, useValue: noCrash },
    FlashSoldOutService,
    FlashReservationSource,
    { provide: FLASH_RESERVATION, useExisting: FlashReservationSource },
  ],
  exports: [
    FLASH_SALE_REPOSITORY,
    FLASH_FAST_STORE,
    FLASH_SALE_DIRECTORY,
    FLASH_RANDOM,
    FLASH_CRASH_POINT,
    FLASH_RESERVATION,
    FlashReservationSource,
  ],
})
export class FlashSaleCoreModule {}
