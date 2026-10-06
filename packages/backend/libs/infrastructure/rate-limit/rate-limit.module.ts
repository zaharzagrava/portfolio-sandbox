import { Global, Module } from '@nestjs/common';
import { RateLimiterService } from './rate-limiter.service';
import { RateLimitInterceptor } from './rate-limit.interceptor';

/** Requires the global RedisModule. */
@Global()
@Module({
  providers: [RateLimiterService, RateLimitInterceptor],
  exports: [RateLimiterService, RateLimitInterceptor],
})
export class RateLimitModule {}
