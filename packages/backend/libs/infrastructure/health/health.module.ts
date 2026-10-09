import { Global, Module, OnModuleInit, Optional } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { ModuleRef } from '@nestjs/core';
import { Sequelize } from 'sequelize-typescript';
import { HealthController } from './health.controller';
import {
  eventLoopLagSamplerProvider,
  LivenessService,
} from './liveness.service';
import { ReadinessService } from './readiness.service';
import { StartupService } from './startup.service';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { LoadSheddingModule } from '@app/common/load-shedding/load-shedding.module';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle/shutdown-registry.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';

@Global()
@Module({
  imports: [ClockModule, LoadSheddingModule],
  controllers: [HealthController],
  providers: [
    ReadinessService,
    StartupService,
    LivenessService,
    eventLoopLagSamplerProvider,
    ShutdownRegistry,
  ],
  exports: [
    ReadinessService,
    StartupService,
    LivenessService,
    ShutdownRegistry,
  ],
})
export class HealthModule implements OnModuleInit {
  constructor(
    private readonly readiness: ReadinessService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  onModuleInit() {
    // Shared dependencies are resolved lazily so apps without them still boot. All are `shared`: reported, never
    // pulling the fleet out of the load balancer (S54 FR-029); promote one with `critical` + a threshold where needed.
    const sequelize = this.optional<Sequelize>(getConnectionToken());
    if (sequelize) {
      this.readiness.register({
        name: 'postgres',
        scope: 'shared',
        check: async () => void (await sequelize.query('SELECT 1')),
      });
    }
    const redis = this.optional<RedisService>(RedisService);
    if (redis) {
      this.readiness.register({
        name: 'redis',
        scope: 'shared',
        check: async () => void (await redis.client.ping()),
      });
    }
    const search = this.optional<ElasticsearchService>(ElasticsearchService);
    if (search) {
      this.readiness.register({
        name: 'elasticsearch',
        scope: 'shared',
        check: async (signal) =>
          void (await search.getClient().ping({}, { signal })),
      });
    }
  }

  private optional<T>(token: unknown): T | undefined {
    try {
      return this.moduleRef?.get(token as never, { strict: false });
    } catch {
      return undefined;
    }
  }
}
