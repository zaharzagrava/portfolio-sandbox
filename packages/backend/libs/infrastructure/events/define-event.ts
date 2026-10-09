import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { context, propagation } from '@opentelemetry/api';
import { EVENT_TYPE_PATTERN } from '@marketplace-sandbox/contracts';
import { Clock, SystemClock } from '@app/common/core/clock';
import { DomainTopic, EventEnvelope, topicFor } from './event-envelope';
import {
  DuplicateEventDefinitionError,
  EventTooLargeError,
  InvalidAggregateVersionError,
  InvalidEventPayloadError,
  InvalidEventTypeError,
} from './event-errors';

/** Serialized envelope limit (FR-003). */
export const MAX_EVENT_BYTES = 256 * 1024;

export type EventCarries = 'state' | 'delta';

export interface EventDefinition<
  TType extends string,
  TAggregate extends string,
  TSchema extends z.ZodType,
> {
  type: TType;
  version: number;
  aggregateType: TAggregate;
  topic: DomainTopic<TAggregate>;
  schema: TSchema;
  /** `state`: the payload is the full aggregate state (safe to compact and to coalesce); `delta`: a change. */
  carries: EventCarries;
  create(
    aggregateId: string,
    aggregateVersion: number,
    payload: z.infer<TSchema>,
    occurredAt?: Date,
  ): EventEnvelope<TType, z.infer<TSchema>>;
  /** Narrows an envelope to this `(type, version)` and validates its payload; null for any other pair. */
  match(
    envelope: Pick<EventEnvelope, 'type' | 'version'> & EventEnvelope,
  ): EventEnvelope<TType, z.infer<TSchema>> | null;
}

let clock: Clock = new SystemClock();

/** Binds the injected time source used for `occurredAt` (EventsModule does it at init; tests pass a FakeClock). */
export const useEventClock = (next: Clock): void => {
  clock = next;
};

const registry = new Map<string, EventDefinition<string, string, z.ZodType>>();

/** Every definition registered so far, keyed `type@version` (consumers and topic policy read it). */
export const registeredEventDefinitions = (): ReadonlyMap<
  string,
  EventDefinition<string, string, z.ZodType>
> => registry;

const failedPaths = (error: z.ZodError): string[] => [
  ...new Set(error.issues.map((issue) => issue.path.join('.'))),
];

const validPayload = <TSchema extends z.ZodType>(
  type: string,
  schema: TSchema,
  payload: unknown,
): z.infer<TSchema> => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new InvalidEventPayloadError(type, failedPaths(parsed.error));
  return parsed.data;
};

/**
 * Typed event definitions: type, owning aggregate, contract version, payload schema. Producers get compile-time
 * payload types and a strict producer-side validation; consumers get `match` at the trust boundary.
 *
 *   export const AuctionBidPlaced = defineEvent('auction.bid_placed', 'auctions', 1, z.object({...}));
 *
 * Registration throws on a malformed type or version and on a duplicate `(type, version)`.
 */
export function defineEvent<
  TType extends string,
  TAggregate extends string,
  TSchema extends z.ZodType,
>(
  type: TType,
  aggregateType: TAggregate,
  version: number,
  schema: TSchema,
  options: { carries?: EventCarries } = {},
): EventDefinition<TType, TAggregate, TSchema> {
  if (!EVENT_TYPE_PATTERN.test(type))
    throw new InvalidEventTypeError(
      `type "${type}" is not lowercase dotted (a.b_c)`,
    );
  if (!Number.isInteger(version) || version < 1)
    throw new InvalidEventTypeError(
      `contract version of ${type} must be a positive integer`,
    );
  if (registry.has(`${type}@${version}`))
    throw new DuplicateEventDefinitionError(type, version);

  const definition: EventDefinition<TType, TAggregate, TSchema> = {
    type,
    version,
    aggregateType,
    topic: topicFor(aggregateType),
    schema,
    carries: options.carries ?? 'delta',
    create(aggregateId, aggregateVersion, payload, occurredAt) {
      if (!Number.isSafeInteger(aggregateVersion) || aggregateVersion < 0)
        throw new InvalidAggregateVersionError(type);
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      const envelope: EventEnvelope<TType, z.infer<TSchema>> = {
        eventId: uuidv7(),
        type,
        version,
        aggregateType,
        aggregateId,
        aggregateVersion,
        occurredAt: (occurredAt ?? clock.now()).toISOString(),
        ...(carrier.traceparent && { traceparent: carrier.traceparent }),
        payload: validPayload(type, schema, payload),
      };
      const bytes = Buffer.byteLength(JSON.stringify(envelope));
      if (bytes > MAX_EVENT_BYTES)
        throw new EventTooLargeError(type, MAX_EVENT_BYTES, bytes);
      return envelope;
    },
    match(envelope) {
      if (envelope.type !== type || envelope.version !== version) return null;
      return {
        ...envelope,
        type,
        payload: validPayload(type, schema, envelope.payload),
      };
    },
  };
  registry.set(`${type}@${version}`, definition);
  return definition;
}
