import {
  flagArchived,
  flagKilled,
  flagNotFound,
  invalidTransition,
  versionConflict,
  type FlagError,
} from './flag-errors';
import type { DefinitionInput } from './flag-validation';
import type {
  FlagAction,
  FlagDefinitionBody,
  FlagState,
  FlagStatus,
} from './flag-types';

export type FlagCommand =
  | { type: 'save'; input: DefinitionInput; expectedVersion: number }
  | { type: 'kill' }
  | { type: 'restore' }
  | { type: 'archive' };

export type Decision =
  | { kind: 'noop' }
  | {
      kind: 'apply';
      action: FlagAction;
      status: FlagStatus;
      definition: FlagDefinitionBody;
    }
  | { kind: 'reject'; error: FlagError };

const reject = (error: FlagError): Decision => ({ kind: 'reject', error });

export function assertNever(value: never): never {
  throw new Error(`unhandled flag command: ${JSON.stringify(value)}`);
}

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, sortKeys(v)]),
        )
      : value;

/** Stable text of any JSON value (object keys sorted), so two equal definitions compare equal whatever their key order. */
export const stableJson = (value: unknown): string =>
  JSON.stringify(sortKeys(value));

/** The definition exactly as it is stored and compared: defaults filled, `expiresAt` an ISO instant or null. */
export function normalizeDefinition(
  input: DefinitionInput,
): FlagDefinitionBody {
  return {
    description: input.description ?? '',
    owner: input.owner,
    variants: input.variants.map((v) => ({
      key: v.key,
      value: v.value as FlagDefinitionBody['variants'][number]['value'],
    })),
    defaultVariant: input.defaultVariant,
    offVariant: input.offVariant,
    rules: input.rules.map((rule) => ({
      id: rule.id,
      conditions: rule.conditions.map((c) => ({
        attribute: c.attribute,
        op: c.op as FlagDefinitionBody['rules'][number]['conditions'][number]['op'],
        values: c.values ?? [],
      })),
      ...(rule.variant !== undefined && { variant: rule.variant }),
      ...(rule.rollout !== undefined && {
        rollout: rule.rollout.map((s) => ({
          variant: s.variant,
          weight: s.weight,
        })),
      }),
    })),
    bucketBy: (input.bucketBy ?? 'userId') as FlagDefinitionBody['bucketBy'],
    clientSide: input.clientSide ?? false,
    expiresAt:
      input.expiresAt == null ? null : new Date(input.expiresAt).toISOString(),
  };
}

export const sameDefinition = (a: FlagDefinitionBody, b: FlagDefinitionBody) =>
  stableJson(a) === stableJson(b);

/**
 * The state machine of FR-010 – FR-014 as one pure function: the current stored state (null when the key is unknown) and
 * a command give "nothing changes", "apply this" or "refuse with this error". The caller applies it under the row lock.
 * A save checks, in order: archived, unknown key / version, killed + enabled, no-op.
 */
export function decide(
  current: FlagState | null,
  command: FlagCommand,
): Decision {
  switch (command.type) {
    case 'save':
      return decideSave(current, command.input, command.expectedVersion);
    case 'kill':
      if (!current) return reject(flagNotFound());
      if (current.status === 'archived') return reject(flagArchived());
      if (current.status === 'killed') return { kind: 'noop' };
      return {
        kind: 'apply',
        action: 'kill',
        status: 'killed',
        definition: current.definition,
      };
    case 'restore':
      if (!current) return reject(flagNotFound());
      if (current.status === 'archived') return reject(flagArchived());
      if (current.status !== 'killed')
        return reject(invalidTransition(current.status));
      return {
        kind: 'apply',
        action: 'restore',
        status: 'disabled',
        definition: current.definition,
      };
    case 'archive':
      if (!current) return reject(flagNotFound());
      if (current.status === 'archived') return { kind: 'noop' };
      if (current.status === 'enabled')
        return reject(invalidTransition(current.status));
      return {
        kind: 'apply',
        action: 'archive',
        status: 'archived',
        definition: current.definition,
      };
    default:
      return assertNever(command);
  }
}

function decideSave(
  current: FlagState | null,
  input: DefinitionInput,
  expectedVersion: number,
): Decision {
  const definition = normalizeDefinition(input);
  if (!current) {
    if (expectedVersion > 0) return reject(flagNotFound());
    return {
      kind: 'apply',
      action: 'create',
      status: input.enabled ? 'enabled' : 'disabled',
      definition,
    };
  }
  if (current.status === 'archived') return reject(flagArchived());
  const equal = sameDefinition(definition, current.definition);
  const desiredStatus: FlagStatus =
    current.status === 'killed' && !input.enabled
      ? 'killed'
      : input.enabled
        ? 'enabled'
        : 'disabled';
  if (
    expectedVersion !== current.version &&
    !(equal && desiredStatus === current.status)
  )
    return reject(versionConflict(current.version));
  if (current.status === 'killed' && input.enabled) return reject(flagKilled());
  if (equal && desiredStatus === current.status) return { kind: 'noop' };
  return {
    kind: 'apply',
    action: 'update',
    status: desiredStatus,
    definition,
  };
}
