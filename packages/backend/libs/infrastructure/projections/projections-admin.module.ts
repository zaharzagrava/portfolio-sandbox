import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { ConsumerLag } from './consumer-lag';
import { ProjectionActivation } from './projection-activation';
import { ProjectionAdmin } from './projection-admin.service';
import { ProjectionRegistry } from './projection-registry';

/** Just what the operator commands need (`projections:rebuild|promote|rollback`): no consumers are started. */
@Module({
  imports: [ApiConfigModule, RedisModule],
  providers: [
    ConsumerLag,
    ProjectionAdmin,
    ProjectionActivation,
    ProjectionRegistry,
  ],
  exports: [ConsumerLag, ProjectionAdmin, ProjectionActivation],
})
export class ProjectionsAdminModule {}
