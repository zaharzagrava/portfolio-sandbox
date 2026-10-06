import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { FlagsAdminService } from './application/flags-admin.service';
import { FlagsController } from './api/flags.controller';

/** SD-38 admin + client endpoint (core). */
@Module({
  imports: [AuthModule],
  providers: [FlagsAdminService],
  exports: [FlagsAdminService],
  controllers: [FlagsController],
})
export class FlagsAdminModule {}
