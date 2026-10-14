import { Inject, Injectable, Logger } from '@nestjs/common';
import { withTimeout } from '../domain/with-timeout';
import {
  FLAG_REPOSITORY,
  RULESET_PUBLISHER,
  type FlagRepository,
  type RulesetPublisher,
} from '../domain/ports';
import { flagsRepairTotal } from './flags-metrics';
import { RulesetPublisherService } from './ruleset-publisher.service';

export type RepairOutcome = 'ok' | 'republished' | 'failed' | 'skipped';

const CACHE_READ_TIMEOUT_MS = 500;

/**
 * Heals a lost publication or a flushed cache without admin action (FR-033, R-8): when the cache holds no snapshot, a
 * corrupt one, or an older version than the database, the snapshot is published again. The code that handles a failure
 * must itself survive that failure (L-016): every cache error is caught and counted, never thrown, so the schedule keeps
 * running. Concurrent calls in one process share one run; across replicas the job runs with a fleet concurrency of one.
 */
@Injectable()
export class RulesetRepairService {
  private readonly logger = new Logger(RulesetRepairService.name);
  private running: Promise<RepairOutcome> | null = null;

  constructor(
    @Inject(FLAG_REPOSITORY) private readonly flags: FlagRepository,
    @Inject(RULESET_PUBLISHER) private readonly publisher: RulesetPublisher,
    private readonly publishing: RulesetPublisherService,
  ) {}

  run(): Promise<RepairOutcome> {
    if (this.running) {
      flagsRepairTotal.add(1, { outcome: 'skipped' });
      return this.running;
    }
    const run = this.repair().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async repair(): Promise<RepairOutcome> {
    let outcome: RepairOutcome;
    try {
      const databaseVersion = await this.flags.rulesetVersion();
      const cached = await withTimeout(
        this.publisher.cachedVersion(),
        CACHE_READ_TIMEOUT_MS,
        'ruleset cache',
      ).catch(() => null);
      if (cached !== null && cached >= databaseVersion) outcome = 'ok';
      else
        outcome = (await this.publishing.publish()) ? 'republished' : 'failed';
    } catch (error) {
      this.logger.warn(`ruleset repair failed: ${(error as Error).message}`);
      outcome = 'failed';
    }
    flagsRepairTotal.add(1, { outcome });
    return outcome;
  }
}
