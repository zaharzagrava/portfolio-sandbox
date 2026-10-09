import { TrendingConsumer } from './infra/trending.consumer';
import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { TrendingService } from './application/trending.service';
import { TrendingController } from './api/trending.controller';

/** SD-32 trending reads (core). The streaming top-K consumer runs in apps/projector (TrendingConsumerModule). */
@Module({
  imports: [AuthModule, CacheModule],
  providers: [TrendingService],
  controllers: [TrendingController],
})
export class TrendingModule {}

@Module({ providers: [TrendingConsumer], exports: [TrendingConsumer] })
export class TrendingConsumerModule {}
