import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { RedisService } from './redis.service';
import { ReadinessService } from '@app/infrastructure/health';
import {
  TEST_CLEANUP,
  TestCleanupPort,
} from '@app/common/testing/test-cleanup.port';

@Global()
@Module({
  imports: [ApiConfigModule],
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule implements OnModuleInit {
  constructor(
    private readonly redis: RedisService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    let readiness: ReadinessService | undefined;
    try {
      readiness = this.moduleRef.get(ReadinessService, { strict: false });
    } catch {
      readiness = undefined;
    }
    // Non-critical by design: every Redis-backed feature defines its own fail-open/closed behaviour (SD-28, SD-34).
    // e2e specs: SeedsService.clean() also flushes the (dedicated, docker-compose.test) Redis DB.
    try {
      this.moduleRef
        .get<TestCleanupPort>(TEST_CLEANUP, { strict: false })
        .register(
          'redis.flushdb',
          async () => void (await this.redis.client.flushdb()),
        );
    } catch {
      // not a test module
    }

    readiness?.register({
      name: 'redis',
      critical: false,
      check: async () => {
        await this.redis.client.ping();
      },
    });
  }
}
