import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ExperimentResults } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  analyticsStoreUnavailable,
  experimentNotFound,
} from '../domain/experiment-errors';
import {
  EVENT_STORE,
  EXPERIMENT_REPOSITORY,
  type EventStore,
  type ExperimentRepository,
  type ResultsCounts,
} from '../domain/ports';
import { assembleResults } from '../domain/results';
import { withTimeout } from '../domain/with-timeout';
import {
  analyticsStoreErrorsTotal,
  experimentResultsTotal,
  experimentSrmMismatchTotal,
} from './analytics-metrics';

/** The analytical read must answer within this long, else the readout is `503` and shows no number (S39 FR-045). */
export const RESULTS_TIMEOUT_MS = 10_000;

const NOTHING: ResultsCounts = {
  variants: [],
  crossoverUnits: 0,
  unattributable: 0,
  unknownVariant: 0,
};

/**
 * The readout of one experiment (S39 FR-040 – FR-045): the experiment from the database, the counts from one read of the
 * analytical store over `[startedAt, stoppedAt or now]`, and the pure assembly of the two. A draft has nothing to read. If the
 * store fails or is too slow the answer is `503 analytics_store_unavailable`: never a partial number.
 */
@Injectable()
export class ExperimentResultsService {
  private readonly logger = new Logger(ExperimentResultsService.name);

  constructor(
    @Inject(EXPERIMENT_REPOSITORY)
    private readonly experiments: ExperimentRepository,
    @Inject(EVENT_STORE) private readonly store: EventStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async results(key: string): Promise<ExperimentResults> {
    const experiment = await this.experiments.find(key);
    if (!experiment) throw experimentNotFound();
    const asOf = this.clock.now();

    let counts = NOTHING;
    if (experiment.startedAt) {
      try {
        counts = await withTimeout(
          this.store.readResults({
            experimentKey: experiment.key,
            metric: experiment.metric,
            unit: experiment.unit,
            variants: experiment.variants.map((v) => v.key),
            windowStart: experiment.startedAt,
            windowEnd: experiment.stoppedAt ?? asOf,
          }),
          RESULTS_TIMEOUT_MS,
          'experiment results',
        );
      } catch (error) {
        analyticsStoreErrorsTotal.add(1, { operation: 'results' });
        this.logger.warn({
          event: 'experiments.results_unavailable',
          experiment: key,
          reason: (error as Error)?.name,
        });
        throw analyticsStoreUnavailable();
      }
    }

    const results = assembleResults({ experiment, counts, asOf });
    experimentResultsTotal.add(1, { trustworthy: String(results.trustworthy) });
    if (results.srm.mismatch) experimentSrmMismatchTotal.add(1);
    return results;
  }
}
