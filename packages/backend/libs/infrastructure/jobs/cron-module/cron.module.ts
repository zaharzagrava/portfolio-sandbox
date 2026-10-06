import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { ApiConfigModule } from '@app/common/config/api-config.module';

@Module({
  imports: [ApiConfigModule],
  providers: [CronService],
  exports: [CronService],
})
export class CronModule {}
