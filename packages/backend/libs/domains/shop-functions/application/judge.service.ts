import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  afterCommit,
  RequestContext,
  TransactionRunner,
} from '@app/infrastructure/context';
import {
  ACTIVE_SET_CACHE,
  FUNCTION_RUNNER,
  VERSION_REPOSITORY,
  type ActiveSetCache,
  type FunctionRunner,
  type VersionRepository,
} from '../domain/ports';
import { functionsLog } from './functions-log';
import { ShopFunctionsConfig } from './shop-functions.config';
import { shopFunctionsMetrics } from './shop-functions.metrics';

export type JudgeOutcome =
  'active' | 'rejected' | 'superseded' | 'unavailable' | 'noop';

/**
 * The judge coordinator (S45 FR-018/FR-019). It claims a version in a short transaction, hands source and frozen cases
 * to the runner with NO connection held, and applies the verdicts in a second short transaction. Seller code never runs
 * here: only the function-runner executes it. Every step is idempotent: a duplicate, concurrent, crashed or late
 * delivery produces one outcome.
 */
@Injectable()
export class JudgeService {
  private readonly logger = new Logger(JudgeService.name);

  constructor(
    @Inject(VERSION_REPOSITORY) private readonly versions: VersionRepository,
    @Inject(FUNCTION_RUNNER) private readonly runnerClient: FunctionRunner,
    @Inject(ACTIVE_SET_CACHE) private readonly activeSet: ActiveSetCache,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: TransactionRunner,
    private readonly config: ShopFunctionsConfig,
    @Optional() private readonly context?: RequestContext,
  ) {}

  async judge(functionId: string, version: number): Promise<JudgeOutcome> {
    const claim = await this.runner.run(() =>
      this.versions.claimForJudge(functionId, version, this.clock.now()),
    );
    if (!claim) return 'noop';

    // A version with no frozen case (a legacy row) cannot pass: nothing proves it.
    const verdicts =
      claim.cases.length === 0
        ? []
        : await this.runnerClient.run({
            runId: randomUUID(),
            source: claim.source,
            cases: claim.cases,
            caseBudgetMs: this.config.caseBudgetMs,
            totalBudgetMs: this.config.versionBudgetMs,
          });
    if (!verdicts || verdicts.length !== claim.cases.length) {
      // Stays TESTING; the recovery job asks again.
      shopFunctionsMetrics.judge('unavailable');
      functionsLog(this.logger, this.context, 'warn', 'judge_unavailable', {
        version,
      });
      return 'unavailable';
    }
    const passed =
      claim.cases.length > 0 && verdicts.every((v) => v.verdict === 'pass');

    const applied = await this.runner.run(async () => {
      const result = await this.versions.applyJudgeResult({
        functionId,
        version,
        verdicts,
        passed,
        now: this.clock.now(),
      });
      if (result.outcome !== 'noop') {
        const shopId = result.shopId;
        afterCommit(() => this.activeSet.drop(shopId));
      }
      return result;
    });
    if (applied.outcome === 'noop') return 'noop';
    shopFunctionsMetrics.judge(applied.outcome);
    return applied.outcome;
  }
}
