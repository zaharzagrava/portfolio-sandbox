import { Global, Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { CacheService } from './cache.service';

/** Requires the global RedisModule. */
@Global()
@Module({
  imports: [ApiConfigModule],
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
