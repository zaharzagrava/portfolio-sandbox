import { Module } from '@nestjs/common';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { SnapshotService } from './application/snapshot.service';
import {
  DASHBOARD_TICKER_OPTIONS,
  DashboardTicker,
} from './infra/dashboard-ticker.service';
import { SnapshotJobs } from './infra/snapshot.jobs';
import { SellerInsightsStoresModule } from './seller-insights-stores.module';

/** S40 periodic work (apps/worker): the dashboard ticker and the period freeze jobs. */
@Module({
  imports: [
    RealtimeModule,
    JobsModule,
    ClockModule,
    SellerInsightsStoresModule,
  ],
  providers: [
    { provide: DASHBOARD_TICKER_OPTIONS, useValue: {} },
    DashboardTicker,
    SnapshotService,
    SnapshotJobs,
  ],
})
export class LeaderboardsWorkerModule {}
