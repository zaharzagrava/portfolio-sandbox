import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { ShopOwnerPromotionConsumer } from './infra/shop-owner-promotion.consumer';
import SigningKey from './infra/models/signing-key.model';
import { AuthModule } from './auth.module';
import { KeyRotationJobs } from './infra/keys/key-rotation.jobs';
import { MfaStateJobs } from './infra/jobs/mfa-state.jobs';
import { ResetTokenJobs } from './infra/jobs/reset-token.jobs';

/**
 * Signing-key rotation and second-factor housekeeping jobs, and the consumer of `tenancy.shop_created` that promotes a
 * `USER` owner to `SELLER` (S03 follow-up), hosted by apps/worker.
 */
@Module({
  imports: [
    AuthModule,
    SequelizeModule.forFeature([SigningKey]),
    ProjectionsModule.forProjectors([ShopOwnerPromotionConsumer], [AuthModule]),
  ],
  providers: [KeyRotationJobs, MfaStateJobs, ResetTokenJobs],
})
export class AuthWorkerModule {}
