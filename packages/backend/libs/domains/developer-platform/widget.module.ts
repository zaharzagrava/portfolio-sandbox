import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { WidgetService } from './application/widget.service';
import { WidgetController } from './api/widget.controller';

/** SD-01 widget backend (core). The loader script is served by the edge (packages/edge-be/src/widget-loader.ts). */
@Module({
  imports: [AuthModule, CacheModule],
  providers: [WidgetService],
  exports: [WidgetService],
  controllers: [WidgetController],
})
export class WidgetModule {}
