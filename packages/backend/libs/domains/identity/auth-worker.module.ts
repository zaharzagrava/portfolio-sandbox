import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import SigningKey from './infra/models/signing-key.model';
import { AuthModule } from './auth.module';
import { KeyRotationJobs } from './infra/keys/key-rotation.jobs';
import { MfaStateJobs } from './infra/jobs/mfa-state.jobs';

/** Signing-key rotation and second-factor housekeeping jobs, hosted by apps/worker. */
@Module({
  imports: [AuthModule, SequelizeModule.forFeature([SigningKey])],
  providers: [KeyRotationJobs, MfaStateJobs],
})
export class AuthWorkerModule {}
