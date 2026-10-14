import type { Experiment } from '@marketplace-sandbox/contracts';
import type { StoredExperiment } from '../domain/experiment-types';

const iso = (at: Date | null): string | null => (at ? at.toISOString() : null);

/** The explicit response mapper: only contract fields leave the service, never a column that is not in the schema. */
export function toExperimentView(experiment: StoredExperiment): Experiment {
  return {
    key: experiment.key,
    description: experiment.description,
    owner: experiment.owner,
    unit: experiment.unit,
    status: experiment.status,
    variants: experiment.variants.map((v) => ({
      key: v.key,
      weight: v.weight,
    })),
    layer: experiment.layer,
    layerFrom: experiment.layerFrom,
    layerTo: experiment.layerTo,
    metric: experiment.metric,
    version: experiment.version,
    startedAt: iso(experiment.startedAt),
    stoppedAt: iso(experiment.stoppedAt),
    startedBy: experiment.startedBy,
    stoppedBy: experiment.stoppedBy,
    createdAt: experiment.createdAt.toISOString(),
    updatedAt: experiment.updatedAt.toISOString(),
  };
}
