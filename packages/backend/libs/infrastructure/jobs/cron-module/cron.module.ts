import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { ApiConfigModule } from '@app/common/config';

@Module({
  imports: [ApiConfigModule],
  providers: [CronService],
  exports: [CronService],
})
export class CronModule {}
