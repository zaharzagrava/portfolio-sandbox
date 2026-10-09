import { Inject, Injectable, Optional } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { sleep } from '@app/common/core/backoff';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { CONSUMER_RANDOM } from './projection-runner.service';
import { ProjectionCheckpoints } from './read-your-writes';
import { MAX_WAIT_MS, waitForVersion } from './read-your-writes-wait';

const outcomes = MetricsRegistry.counter({
  name: 'read_your_writes_total',
  help: 'Reads that asked for a minimum version, by how they were answered',
  labels: ['outcome', 'reason'],
});

export interface ResolveOptions<T> {
  /** The consumer whose read model the caller would read, and the aggregate it asks about. */
  consumer: string;
  aggregateType: string;
  aggregateId: string;
  /** From `parseMinVersion`; undefined means no read-your-writes was requested: serve the read model, wait for nothing. */
  minVersion: number | undefined;
  /** Wait budget in ms (default `ryw_wait_budget_ms`, clamped to 2,000). */
  waitMs?: number;
  /** Behind after the budget: read the write model (`fallback`) or let the route answer `202` (`pending`). */
  onBehind: 'fallback' | 'pending';
  /** The caller's read of the source of truth, already scoped to the principal (R1). Only called on fallback. */
  readWriteModel: () => Promise<T>;
  /**
   * The caller's tenant check. It runs first and throws to refuse: nothing is looked up, waited for or revealed for a
   * caller that does not own the aggregate (S53 FR-049).
   */
  authorize?: () => Promise<void>;
  /** The applied version, when it is not the consumer's checkpoint (a read replica's version). */
  probe?: () => Promise<number>;
}

export type ReadResolution<T> =
  | { source: 'read-model' }
  | { source: 'write-model'; value: T }
  | { source: 'pending'; requiredVersion: number };

/**
 * Read-your-writes on top of eventually consistent read models (S53 FR-047 to FR-050): a write returns the
 * aggregate's version; a read that passes it as `minVersion` is served from the read model when the consumer has
 * caught up, waits a short budget for it to, and otherwise falls back to the write model or says "still processing".
 * A checkpoint store that is down never breaks the read: it falls back at once.
 */
@Injectable()
export class ReadYourWrites {
  constructor(
    private readonly checkpoints: ProjectionCheckpoints,
    private readonly config: ApiConfigService,
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = new SystemClock(),
    @Optional()
    @Inject(CONSUMER_RANDOM)
    private readonly random: () => number = Math.random,
  ) {}

  async resolve<T>(options: ResolveOptions<T>): Promise<ReadResolution<T>> {
    await options.authorize?.();
    const { minVersion } = options;
    if (minVersion === undefined) {
      outcomes.add(1, { outcome: 'read_model', reason: 'no_min_version' });
      return { source: 'read-model' };
    }

    const probe =
      options.probe ??
      (() =>
        this.checkpoints.projectedVersion(
          options.consumer,
          options.aggregateType,
          options.aggregateId,
        ));
    const budget = Math.min(
      options.waitMs ?? this.config.get('ryw_wait_budget_ms'),
      MAX_WAIT_MS,
    );
    const outcome = await waitForVersion({
      probe,
      minVersion,
      budgetMs: budget,
      clock: this.clock,
      sleep: (ms) => sleep(ms),
      random: this.random,
    });

    if (outcome === 'reached') {
      outcomes.add(1, { outcome: 'read_model', reason: 'caught_up' });
      return { source: 'read-model' };
    }
    if (outcome === 'unavailable') {
      outcomes.add(1, {
        outcome: 'fallback',
        reason: 'checkpoint_unavailable',
      });
      return { source: 'write-model', value: await options.readWriteModel() };
    }
    if (options.onBehind === 'pending') {
      outcomes.add(1, { outcome: 'pending', reason: 'timeout' });
      return { source: 'pending', requiredVersion: minVersion };
    }
    outcomes.add(1, { outcome: 'fallback', reason: 'timeout' });
    return { source: 'write-model', value: await options.readWriteModel() };
  }
}
