import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { ApiConfigModule } from '@app/common/config';

/**
 * In-process ticker: every replica runs it. It exists only for per-replica pollers (the outbox poller).
 * Work that must run once per schedule MUST NOT use it - register a schedule with `JobsService.upsertSchedule` instead,
 * which elects one leader per tick and dedupes each fire by key (S49 FR-060, constitution VIII.6).
 */
@Module({
  imports: [ApiConfigModule],
  providers: [CronService],
  exports: [CronService],
})
export class CronModule {}
