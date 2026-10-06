import { Module } from '@nestjs/common';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { DashboardTicker } from './infra/dashboard-ticker.service';
import { LeaderboardSnapshotJobs } from './infra/leaderboard-snapshot.jobs';

/** SD-18 periodic work (apps/worker): dashboard ticker + period snapshots. */
@Module({
  imports: [RealtimeModule, JobsModule],
  providers: [DashboardTicker, LeaderboardSnapshotJobs],
  exports: [DashboardTicker, LeaderboardSnapshotJobs],
})
export class LeaderboardsWorkerModule {}
