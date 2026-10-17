import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  FRONTIER,
  TARGET_REPOSITORY,
  type FrontierPort,
  type TargetRepository,
} from '../domain/crawler-ports';
import { CompetitorEvaluationService } from './competitor-evaluation.service';
import { QUEUE_MARK_STALE_MS } from './crawl.constants';
import { CrawlerConfig } from './crawler.config';
import { crawlerMetrics } from './crawler.metrics';

/** Evaluations the scheduler repairs per run (a crash between the observation and its last batch, research D-06). */
const REPAIR_PER_RUN = 20;

/**
 * The scheduler (every minute, one run across replicas by S49): each due, watched, non-paused target goes onto the
 * frontier at most once per queue mark (FR-011). The frontier is derived, so a lost one is rebuilt by the next run
 * from the database alone.
 */
@Injectable()
export class CrawlSchedulerService {
  private readonly logger = new Logger(CrawlSchedulerService.name);

  constructor(
    @Inject(TARGET_REPOSITORY) private readonly targets: TargetRepository,
    @Inject(FRONTIER) private readonly frontier: FrontierPort,
    private readonly evaluation: CompetitorEvaluationService,
    private readonly config: CrawlerConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Returns how many targets were queued. */
  async scheduleDue(limit = this.config.settings.scheduleCap): Promise<number> {
    const now = this.clock.now();
    const due = await this.targets.due(now, limit);
    let queued = 0;
    for (const target of due) {
      if (
        !(await this.frontier.mark(
          target.id,
          now.getTime(),
          QUEUE_MARK_STALE_MS,
        ))
      )
        continue;
      await this.frontier.push(target.host, target.id);
      queued++;
    }
    await this.repairEvaluations();
    await this.refreshGauges(now);
    return queued;
  }

  private async repairEvaluations(): Promise<void> {
    try {
      for (const id of await this.targets.unevaluated(REPAIR_PER_RUN))
        await this.evaluation.evaluatePending(id);
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'evaluation_repair_failed',
          error: (error as Error).name,
        }),
      );
    }
  }

  private async refreshGauges(now: Date): Promise<void> {
    try {
      const overdue = await this.targets.overdue(now);
      crawlerMetrics.overdue(overdue.count, overdue.oldestSeconds);
      crawlerMetrics.readyHosts(await this.frontier.readyHosts());
    } catch {
      // gauges are best effort: a failed read keeps the last value
    }
  }
}
