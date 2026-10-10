import { DynamicModule, Global, Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { CacheService } from './cache.service';
import {
  CACHE_TOOLKIT_CONFIG,
  CacheToolkitConfig,
  resolveCacheConfig,
} from './cache.config';
import { DistributedLock } from './distributed-lock';
import { VersionEtagInterceptor } from './etag.interceptor';
import { RANDOM_SOURCE, SystemRandom } from './random-source';

const providers = (overrides: Partial<CacheToolkitConfig> = {}) => [
  {
    provide: CACHE_TOOLKIT_CONFIG,
    // Resolved here so an invalid setting fails the boot (VIII.5), not the first read.
    useFactory: () => resolveCacheConfig(overrides),
  },
  { provide: RANDOM_SOURCE, useClass: SystemRandom },
  CacheService,
  DistributedLock,
  VersionEtagInterceptor,
];

const exported = [CacheService, DistributedLock, VersionEtagInterceptor];

/** Requires the global RedisModule; takes `CLOCK` from the global ClockModule when the app has one. */
@Global()
@Module({
  imports: [ApiConfigModule],
  providers: providers(),
  exports: exported,
})
export class CacheModule {
  /** Same module with tuned settings (validated at boot). */
  static register(overrides: Partial<CacheToolkitConfig>): DynamicModule {
    return {
      module: CacheModule,
      global: true,
      imports: [ApiConfigModule],
      providers: providers(overrides),
      exports: exported,
    };
  }
}
