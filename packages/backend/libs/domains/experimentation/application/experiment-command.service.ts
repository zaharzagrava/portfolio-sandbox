import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EXPERIMENT_LIMITS,
  type Experiment,
  type ExperimentWrite,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { RequestContext, TransactionRunner } from '@app/infrastructure/context';
import { validateDefinition } from '../domain/experiment-definition';
import {
  experimentDefinitionInvalid,
  experimentLimitReached,
  layerRangeConflict,
} from '../domain/experiment-errors';
import { decide, type ExperimentCommand } from '../domain/experiment-lifecycle';
import type {
  ExperimentAction,
  ExperimentDefinition,
  StoredExperiment,
} from '../domain/experiment-types';
import {
  EXPERIMENT_REPOSITORY,
  LayerOverlapError,
  RUNNING_SET_CACHE,
  type ExperimentRepository,
  type RunningSetCache,
} from '../domain/ports';
import { toExperimentView } from './experiment-view';

export interface ExperimentCommandResult {
  experiment: Experiment;
  /** The save created the experiment (`201`). */
  created: boolean;
  /** Something changed (one history row exists for it). */
  changed: boolean;
}

/** The pure part of a write body: defaults filled, nothing else decided. */
const definitionOf = (input: ExperimentWrite): ExperimentDefinition => ({
  description: input.description ?? '',
  owner: input.owner,
  unit: input.unit ?? 'user',
  variants: input.variants.map((v) => ({ key: v.key, weight: v.weight })),
  layer: input.layer,
  layerFrom: input.layerFrom,
  layerTo: input.layerTo,
  metric: input.metric,
});

/**
 * Every write of an experiment: `save`, `start`, `stop` (S39 FR-022 – FR-026). One transaction through
 * `TransactionRunner.run`: take the row (a create first takes the transaction-scoped advisory lock that makes the 200 cap
 * exact), decide with the pure state machine, and for an applied change write the row (a conditional update that must
 * change exactly one row) and one history row together. A no-op returns before anything is written. Overlapping layer
 * ranges are refused by the database's exclusion constraint, so two parallel starts cannot both win. The cache is
 * invalidated, the metric and the log line written after the commit, never inside the transaction.
 */
@Injectable()
export class ExperimentCommandService {
  private readonly logger = new Logger(ExperimentCommandService.name);

  constructor(
    private readonly runner: TransactionRunner,
    @Inject(EXPERIMENT_REPOSITORY)
    private readonly experiments: ExperimentRepository,
    @Inject(RUNNING_SET_CACHE) private readonly runningSet: RunningSetCache,
    private readonly context: RequestContext,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  save(
    key: string,
    input: ExperimentWrite,
    actorId: string,
  ): Promise<ExperimentCommandResult> {
    const definition = definitionOf(input);
    const problems = validateDefinition(definition);
    if (problems.length) throw experimentDefinitionInvalid(problems);
    return this.execute(key, actorId, {
      type: 'save',
      expectedVersion: input.expectedVersion,
      definition,
    });
  }

  start(key: string, actorId: string): Promise<ExperimentCommandResult> {
    return this.execute(key, actorId, { type: 'start' });
  }

  stop(key: string, actorId: string): Promise<ExperimentCommandResult> {
    return this.execute(key, actorId, { type: 'stop' });
  }

  private async execute(
    key: string,
    actorId: string,
    command: ExperimentCommand,
  ): Promise<ExperimentCommandResult> {
    const now = this.clock.now();
    let result: {
      experiment: StoredExperiment;
      created: boolean;
      action: ExperimentAction | null;
    };
    try {
      result = await this.runner.run(async () => {
        let current = await this.experiments.findForUpdate(key);
        if (!current && command.type === 'save') {
          // Two creates of one key, or the 200th and 201st, are serialised here; the loser re-reads and decides again.
          await this.experiments.lockCreates();
          current = await this.experiments.findForUpdate(key);
        }

        const decision = decide(current, command);
        if (decision.kind === 'reject') throw decision.error;
        if (decision.kind === 'noop')
          return {
            experiment: current as StoredExperiment,
            created: false,
            action: null,
          };

        let stored: StoredExperiment;
        switch (decision.action) {
          case 'create':
            if (
              (await this.experiments.count()) >= EXPERIMENT_LIMITS.experiments
            )
              throw experimentLimitReached();
            stored = await this.experiments.insert({
              key,
              definition: decision.definition,
              now,
            });
            break;
          case 'update':
            stored = await this.experiments.update({
              key,
              expectedVersion: (current as StoredExperiment).version,
              definition: decision.definition,
              now,
            });
            break;
          case 'start':
          case 'stop':
            stored = await this.experiments.transition({
              key,
              from: (current as StoredExperiment).status,
              to: decision.to,
              actorId,
              now,
            });
            break;
        }
        await this.experiments.appendAudit({
          experimentKey: key,
          action: decision.action,
          actorId,
          requestId: this.context.requestId ?? null,
          before: current ? toExperimentView(current) : null,
          after: toExperimentView(stored),
          at: now,
        });
        return {
          experiment: stored,
          created: decision.action === 'create',
          action: decision.action,
        };
      });
    } catch (error) {
      if (error instanceof LayerOverlapError) throw await this.overlap(key);
      throw error;
    }

    if (result.action) {
      await this.runningSet.invalidate();
      this.logger.log({
        event: 'experiments.changed',
        requestId: this.context.requestId,
        experiment: key,
        action: result.action,
        version: result.experiment.version,
      });
    }
    return {
      experiment: toExperimentView(result.experiment),
      created: result.created,
      changed: result.action !== null,
    };
  }

  /** The refused start, now that its transaction is rolled back: name the experiment that owns the range. */
  private async overlap(key: string) {
    const experiment = await this.experiments.find(key);
    const blocking = experiment
      ? await this.experiments.findBlocking(
          experiment.layer,
          experiment.layerFrom,
          experiment.layerTo,
        )
      : null;
    return layerRangeConflict(blocking);
  }
}
