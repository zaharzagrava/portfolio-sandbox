import type {
  ExperimentDefinitionErrorCode,
  EXPERIMENT_ACTIONS,
  EXPERIMENT_STATUSES,
  EXPERIMENT_UNITS,
} from '@marketplace-sandbox/contracts';

export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export type ExperimentUnit = (typeof EXPERIMENT_UNITS)[number];
export type ExperimentAction = (typeof EXPERIMENT_ACTIONS)[number];

export interface ExperimentVariant {
  key: string;
  weight: number;
}

/** What an admin writes: everything except identity, status and bookkeeping. */
export interface ExperimentDefinition {
  description: string;
  owner: string;
  unit: ExperimentUnit;
  variants: ExperimentVariant[];
  layer: string;
  layerFrom: number;
  layerTo: number;
  metric: string;
}

export interface StoredExperiment extends ExperimentDefinition {
  key: string;
  status: ExperimentStatus;
  version: number;
  startedAt: Date | null;
  stoppedAt: Date | null;
  startedBy: string | null;
  stoppedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A listed experiment with the exact `createdAt` text its keyset cursor needs (the column keeps microseconds). */
export type ListedExperiment = StoredExperiment & { createdAtKey: string };

/** What assignment needs of a running experiment (the cached shape). */
export interface RunningExperiment {
  key: string;
  unit: ExperimentUnit;
  variants: ExperimentVariant[];
  layer: string;
  layerFrom: number;
  layerTo: number;
}

export interface DefinitionProblem {
  path: string;
  code: ExperimentDefinitionErrorCode;
}
