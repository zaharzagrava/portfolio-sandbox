import {
  Body,
  Controller,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsUrl, IsUUID } from 'class-validator';
import { AuthModule } from '@app/domains/identity';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { NotificationsCoreModule } from '@app/domains/notifications';
import { ShopScoped } from '@app/domains/tenancy';
import { CrawlerService } from './application/crawler.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'crawler.schedule-due': Record<string, never>;
  }
}

export class WatchDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsUrl({ require_protocol: true }) url: string;
}

@ApiTags('competitors')
@Controller('shops/:shopId/competitors')
export class CompetitorController {
  constructor(private readonly crawler: CrawlerService) {}

  @ShopScoped('products.write')
  @Post()
  watch(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: WatchDto,
  ) {
    return this.crawler.watch(shopId, body.productId, body.url);
  }
}

const IMPORTS = [StorageModule, ClickHouseModule, NotificationsCoreModule];

/** SD-35 API (core). */
@Module({
  imports: [AuthModule, ...IMPORTS],
  providers: [CrawlerService],
  controllers: [CompetitorController],
})
export class CrawlerModule {}

/**
 * Fetcher loop + scheduler (apps/worker). N fetchers per instance run
 * concurrently across DIFFERENT hosts (the frontier leases hosts); politeness
 * holds fleet-wide because the lease lives in Redis.
 */
@Injectable()
class CrawlerWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private running = true;
  private loops: Promise<void>[] = [];

  constructor(
    private readonly crawler: CrawlerService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({
      name: 'crawler.schedule-due',
      cron: '* * * * *',
      jobType: 'crawler.schedule-due',
      payload: {},
    });
    this.loops = Array.from({ length: 16 }, () => this.loop());
  }

  async onModuleDestroy() {
    this.running = false;
    await Promise.all(this.loops);
  }

  @JobHandler('crawler.schedule-due', { concurrency: 1 })
  scheduleDue() {
    return this.crawler.scheduleDue();
  }

  private async loop() {
    while (this.running) {
      const worked = await this.crawler.crawlNext().catch(() => false);
      if (!worked) await new Promise((r) => setTimeout(r, 500));
    }
  }
}

@Module({
  imports: [...IMPORTS, JobsModule],
  providers: [CrawlerService, CrawlerWorker],
})
export class CrawlerWorkerModule {}
