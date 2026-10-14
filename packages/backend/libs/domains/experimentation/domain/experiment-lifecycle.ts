import {
  experimentImmutable,
  experimentNotFound,
  illegalTransition,
  versionConflict,
  type ExperimentError,
} from './experiment-errors';
import type {
  ExperimentAction,
  ExperimentDefinition,
  ExperimentStatus,
  StoredExperiment,
} from './experiment-types';

export type ExperimentCommand =
  | {
      type: 'save';
      expectedVersion: number;
      definition: ExperimentDefinition;
    }
  | { type: 'start' }
  | { type: 'stop' };

export type ExperimentDecision =
  /** Nothing changes: no write, no history row, no new version. */
  | { kind: 'noop' }
  | { kind: 'reject'; error: ExperimentError }
  | {
      kind: 'apply';
      action: Extract<ExperimentAction, 'create' | 'update'>;
      definition: ExperimentDefinition;
    }
  | {
      kind: 'apply';
      action: Extract<ExperimentAction, 'start' | 'stop'>;
      to: Exclude<ExperimentStatus, 'draft'>;
    };

const reject = (error: ExperimentError): ExperimentDecision => ({
  kind: 'reject',
  error,
});

/** The fields that fix who sees what: they cannot change once an experiment has started (FR-023). */
const sameDesign = (
  a: ExperimentDefinition,
  b: ExperimentDefinition,
): boolean =>
  a.unit === b.unit &&
  a.layer === b.layer &&
  a.layerFrom === b.layerFrom &&
  a.layerTo === b.layerTo &&
  a.metric === b.metric &&
  a.variants.length === b.variants.length &&
  a.variants.every(
    (v, i) => v.key === b.variants[i].key && v.weight === b.variants[i].weight,
  );

const sameDefinition = (
  a: ExperimentDefinition,
  b: ExperimentDefinition,
): boolean =>
  sameDesign(a, b) && a.description === b.description && a.owner === b.owner;

export function assertNever(value: never): never {
  throw new Error(`unhandled experiment status: ${String(value)}`);
}

/**
 * The state machine of an experiment (S39 FR-022, FR-023), pure: it answers what a command does to the stored experiment
 * (`null` when there is none) and never touches a store or a clock. Order of the checks for a save: unknown key, equal
 * definition (a no-op whatever the version, which makes a repeated create harmless), stale version, then immutability.
 * Lifecycle is `draft → running → stopped`, one direction; repeats are no-ops, anything else is `illegal_transition`.
 */
export function decide(
  current: StoredExperiment | null,
  command: ExperimentCommand,
): ExperimentDecision {
  switch (command.type) {
    case 'save': {
      if (!current) {
        if (command.expectedVersion > 0) return reject(experimentNotFound());
        return {
          kind: 'apply',
          action: 'create',
          definition: command.definition,
        };
      }
      if (sameDefinition(current, command.definition)) return { kind: 'noop' };
      if (command.expectedVersion !== current.version)
        return reject(versionConflict(current.version));
      switch (current.status) {
        case 'draft':
          break;
        case 'running':
        case 'stopped':
          if (!sameDesign(current, command.definition))
            return reject(experimentImmutable());
          break;
        default:
          return assertNever(current.status);
      }
      return {
        kind: 'apply',
        action: 'update',
        definition: command.definition,
      };
    }
    case 'start': {
      if (!current) return reject(experimentNotFound());
      switch (current.status) {
        case 'draft':
          return { kind: 'apply', action: 'start', to: 'running' };
        case 'running':
          return { kind: 'noop' };
        case 'stopped':
          return reject(illegalTransition(current.status));
        default:
          return assertNever(current.status);
      }
    }
    case 'stop': {
      if (!current) return reject(experimentNotFound());
      switch (current.status) {
        case 'running':
          return { kind: 'apply', action: 'stop', to: 'stopped' };
        case 'stopped':
          return { kind: 'noop' };
        case 'draft':
          return reject(illegalTransition(current.status));
        default:
          return assertNever(current.status);
      }
    }
    default:
      return assertNever(command);
  }
}
