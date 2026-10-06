import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import SigningKey from './infra/models/signing-key.model';
import { AuthModule } from './auth.module';
import { KeyRotationJobs } from './infra/keys/key-rotation.jobs';

/** Signing-key rotation job, hosted by apps/worker. */
@Module({
  imports: [AuthModule, SequelizeModule.forFeature([SigningKey])],
  providers: [KeyRotationJobs],
})
export class AuthWorkerModule {}
