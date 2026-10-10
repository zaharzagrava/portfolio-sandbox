import {
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
} from '@nestjs/common';
import { APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { ApiConfigService } from '@app/common/config';
import { PolicyRegistry } from './policy-registry';
import type { PolicyTable } from './policy';
import { RateLimitConfig } from './rate-limit.config';
import { RateLimitDenialLog } from './rate-limit-denial-log';
import {
  RATE_LIMIT_ROOT_OPTIONS,
  RateLimitInterceptor,
} from './rate-limit.interceptor';
import { RateLimitMetrics } from './rate-limit.metrics';
import { RateLimiterService } from './rate-limiter.service';
import { RateLimitRouteCheck } from './route-check';
import { ScriptLoader } from './script-loader';
import { StoreGuard } from './store-guard';
import { StoreTimeSource, TimeSource } from './time-source';

const FEATURE_TABLE = Symbol('RATE_LIMIT_FEATURE_TABLE');

/** Registers one owner's policy table at startup; a duplicate or invalid table fails the application. */
@Injectable()
class PolicyTableRegistrar {
  constructor(
    registry: PolicyRegistry,
    @Inject(FEATURE_TABLE) table: PolicyTable,
  ) {
    registry.register(table);
  }
}

/** The engine: service, registry, store guard. Requires the global RedisModule. */
@Global()
@Module({
  providers: [
    PolicyRegistry,
    RateLimitMetrics,
    ScriptLoader,
    StoreGuard,
    { provide: TimeSource, useClass: StoreTimeSource },
    {
      provide: RateLimitConfig,
      useFactory: (config: ApiConfigService) => RateLimitConfig.from(config),
      inject: [ApiConfigService],
    },
    RateLimiterService,
  ],
  exports: [
    PolicyRegistry,
    RateLimitMetrics,
    RateLimitConfig,
    TimeSource,
    StoreGuard,
    ScriptLoader,
    RateLimiterService,
  ],
})
class RateLimitEngineModule {}

/** HTTP enforcement for an application: the default limit, `@RateLimit` and `@RateLimitExempt`, and the startup checks. */
@Module({})
class RateLimitEnforcementModule {}

export interface RateLimitRootOptions {
  /**
   * `false` leaves out the `default.read` / `default.write` floor, so only routes that declare `@RateLimit` are limited.
   * For the shared test harness of other capabilities only; every application keeps the default.
   */
  applyDefault?: boolean;
}

@Module({})
class RateLimitFeatureModule {}

/**
 * - `RateLimitModule` (plain import): the service for code callers (workers, application services).
 * - `RateLimitModule.forRoot()`: once per application; adds HTTP enforcement (FR-047).
 * - `RateLimitModule.forFeature(table)`: each owner registers its `definePolicies(...)` (FR-050).
 */
@Module({
  imports: [RateLimitEngineModule],
  exports: [RateLimitEngineModule],
})
export class RateLimitModule {
  static forRoot(options: RateLimitRootOptions = {}): DynamicModule {
    return {
      module: RateLimitEnforcementModule,
      imports: [RateLimitEngineModule, DiscoveryModule],
      providers: [
        {
          provide: RATE_LIMIT_ROOT_OPTIONS,
          useValue: { applyDefault: options.applyDefault !== false },
        },
        RateLimitInterceptor,
        RateLimitDenialLog,
        RateLimitRouteCheck,
        { provide: APP_INTERCEPTOR, useExisting: RateLimitInterceptor },
      ],
    };
  }

  static forFeature(table: PolicyTable): DynamicModule {
    return {
      module: RateLimitFeatureModule,
      imports: [RateLimitEngineModule],
      providers: [
        { provide: FEATURE_TABLE, useValue: table },
        PolicyTableRegistrar,
      ],
    };
  }
}
