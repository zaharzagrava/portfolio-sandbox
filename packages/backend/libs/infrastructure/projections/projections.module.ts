import { DynamicModule, Inject, Module, OnApplicationBootstrap, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { Projector } from './projector';
import { ProjectionRunner } from './projection-runner.service';
import { ProjectionCheckpoints } from './read-your-writes';
import { RedisDocSink } from './sinks/redis-doc.sink';

const PROJECTORS = Symbol('PROJECTORS');

/**
 * `ProjectionsModule.forProjectors([ProductSearchProjector, ...])` in the
 * `projector` app starts every listed projector once the app has bootstrapped.
 */
@Module({})
export class ProjectionsModule implements OnApplicationBootstrap {
  constructor(
    private readonly runner: ProjectionRunner,
    private readonly moduleRef: ModuleRef,
    @Inject(PROJECTORS) private readonly projectorTypes: Type<Projector>[],
  ) {}

  static forProjectors(projectors: Type<Projector>[], imports: DynamicModule['imports'] = []): DynamicModule {
    return {
      module: ProjectionsModule,
      imports: [ApiConfigModule, ...imports],
      providers: [ProjectionRunner, ProjectionCheckpoints, RedisDocSink, ...projectors, { provide: PROJECTORS, useValue: projectors }],
      exports: [ProjectionRunner, ProjectionCheckpoints, RedisDocSink],
    };
  }

  async onApplicationBootstrap() {
    for (const type of this.projectorTypes) {
      await this.runner.start(this.moduleRef.get(type, { strict: false }));
    }
  }
}
