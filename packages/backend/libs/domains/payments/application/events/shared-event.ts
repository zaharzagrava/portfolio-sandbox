import type { z } from 'zod';
import {
  defineEvent,
  registeredEventDefinitions,
  type EventDefinition,
} from '@app/infrastructure/events/define-event';

/**
 * An event contract that two capabilities touch (payments events are produced here and consumed by orders; order
 * events the other way round) is defined once per process, from the same `packages/contracts` schema. Whichever module
 * asks first defines it; the other finds it in the registry. Call it lazily (at first use, not at import), after every
 * module of the process has loaded, so the order of imports cannot matter.
 */
export function sharedEvent<
  TType extends string,
  TAggregate extends string,
  TSchema extends z.ZodType,
>(
  type: TType,
  aggregateType: TAggregate,
  version: number,
  schema: TSchema,
): EventDefinition<TType, TAggregate, TSchema> {
  const existing = registeredEventDefinitions().get(`${type}@${version}`);
  return (
    (existing as EventDefinition<TType, TAggregate, TSchema> | undefined) ??
    defineEvent(type, aggregateType, version, schema)
  );
}

/** Memoises a lazily built value. */
export function lazy<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}
