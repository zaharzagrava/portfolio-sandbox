import { Global, Module, OnModuleInit, Optional } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { ModuleRef } from '@nestjs/core';
import { Sequelize } from 'sequelize-typescript';
import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle/shutdown-registry.service';

@Global()
@Module({
  controllers: [HealthController],
  providers: [ReadinessService, ShutdownRegistry],
  exports: [ReadinessService, ShutdownRegistry],
})
export class HealthModule implements OnModuleInit {
  constructor(
    private readonly readiness: ReadinessService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  onModuleInit() {
    // Postgres is critical for every app that has it; resolved lazily so apps without Sequelize still boot.
    let sequelize: Sequelize | undefined;
    try {
      sequelize = this.moduleRef?.get(getConnectionToken(), { strict: false });
    } catch {
      sequelize = undefined;
    }

    if (sequelize) {
      this.readiness.register({
        name: 'postgres',
        critical: true,
        check: async () => {
          await sequelize!.query('SELECT 1');
        },
      });
    }
  }
}
