import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  JUDGE_REQUESTS,
  VERSION_REPOSITORY,
  type JudgeRequests,
  type VersionRepository,
} from '../domain/ports';
import { ShopFunctionsConfig } from './shop-functions.config';
import { shopFunctionsMetrics } from './shop-functions.metrics';

const BATCH = 200;

export interface RecoveryResult {
  rerequested: number;
  rejected: number;
}

/**
 * Stuck `QUEUED`/`TESTING` versions (S45 FR-020): untouched for 2 minutes ⇒ one new judge request and one more attempt;
 * at the fifth attempt ⇒ `REJECTED judge_unavailable`. The conditional updates make two runners at once safe; the job
 * itself runs once per schedule across the fleet.
 */
@Injectable()
export class JudgeRecoveryService {
  constructor(
    @Inject(VERSION_REPOSITORY) private readonly versions: VersionRepository,
    @Inject(JUDGE_REQUESTS) private readonly judgeRequests: JudgeRequests,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: TransactionRunner,
    private readonly config: ShopFunctionsConfig,
  ) {}

  async run(): Promise<RecoveryResult> {
    const now = this.clock.now();
    const before = new Date(now.getTime() - this.config.stuckAfterMs);
    const result: RecoveryResult = { rerequested: 0, rejected: 0 };
    const stuck = await this.versions.findStuck(before, BATCH);
    for (const item of stuck) {
      await this.runner.run(async () => {
        if (item.judgeAttempts >= this.config.maxJudgeAttempts) {
          const done = await this.versions.exhaust(
            item.functionId,
            item.version,
            before,
            now,
          );
          if (done) {
            result.rejected++;
            shopFunctionsMetrics.judge('unavailable');
          }
          return;
        }
        const claimed = await this.versions.rerequest(
          item.functionId,
          item.version,
          item.judgeAttempts,
          before,
          now,
        );
        if (!claimed) return;
        await this.judgeRequests.request(item.functionId, item.version);
        result.rerequested++;
      });
    }
    const backlog = await this.versions.backlog(now);
    shopFunctionsMetrics.backlog(backlog.count, backlog.oldestAgeSeconds);
    return result;
  }
}
