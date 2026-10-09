import type { ZodType } from 'zod';
import type { EventDefinition } from '@app/infrastructure/events/define-event';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type { HandledEvent } from './projector';

export type RejectCode =
  'UNSUPPORTED_VERSION' | 'INVALID_PAYLOAD' | 'INVALID_AGGREGATE_ID';

export type RouteResult =
  /** Not a type this consumer handles: offset advances, counted `ignored`. */
  | { kind: 'skip' }
  | {
      kind: 'handle';

      event: EventDefinition<string, string, any>;
      /** The envelope at the handled version, payload validated (and upgraded if it was older). */
      envelope: EventEnvelope;
      payload: Record<string, unknown>;
    }
  /** Dead-letter it: `reason` holds error classes and schema paths, never a value from the message. */
  | { kind: 'reject'; code: RejectCode; reason: string };

const paths = (error: { issues: { path: PropertyKey[] }[] }): string =>
  [
    ...new Set(
      error.issues.map((i) => i.path.map(String).join('.') || '(root)'),
    ),
  ].join(', ');

/**
 * Decides what to do with a valid envelope (S53 FR-026, FR-027): skip unknown types, reject newer contract
 * versions, lift older ones through the declared upgrade steps, then validate the payload against the schema of the
 * handled version.
 */
export function routeEnvelope(
  handles: HandledEvent[],
  envelope: EventEnvelope,
  aggregateIdSchema?: ZodType,
): RouteResult {
  const candidates = handles.filter((h) => h.event.type === envelope.type);
  if (candidates.length === 0) return { kind: 'skip' };

  if (
    aggregateIdSchema &&
    !aggregateIdSchema.safeParse(envelope.aggregateId).success
  )
    return {
      kind: 'reject',
      code: 'INVALID_AGGREGATE_ID',
      reason: `aggregateId of ${envelope.type} does not match the consumer's aggregate id schema`,
    };

  const exact = candidates.find((h) => h.event.version === envelope.version);
  const highest = candidates.reduce((a, b) =>
    b.event.version > a.event.version ? b : a,
  );
  let target: HandledEvent;
  let payload: unknown = envelope.payload;

  if (exact) {
    target = exact;
  } else if (envelope.version > highest.event.version) {
    return {
      kind: 'reject',
      code: 'UNSUPPORTED_VERSION',
      reason: `${envelope.type} version ${envelope.version} is newer than the highest handled version ${highest.event.version}`,
    };
  } else {
    target = highest;
    for (let v = envelope.version; v < target.event.version; v++) {
      const step = target.upgradeFrom?.find((s) => s.version === v);
      if (!step)
        return {
          kind: 'reject',
          code: 'UNSUPPORTED_VERSION',
          reason: `no upgrade step from version ${v} to ${v + 1} for ${envelope.type}`,
        };
      try {
        payload = step.upcast(payload);
      } catch (error) {
        return {
          kind: 'reject',
          code: 'INVALID_PAYLOAD',
          reason: `upgrade from version ${v} of ${envelope.type} failed (${error instanceof Error ? error.name : 'Error'})`,
        };
      }
    }
  }

  const parsed = target.event.schema.safeParse(payload);
  if (!parsed.success)
    return {
      kind: 'reject',
      code: 'INVALID_PAYLOAD',
      reason: `payload of ${envelope.type} v${target.event.version} fails its schema at: ${paths(parsed.error)}`,
    };
  return {
    kind: 'handle',
    event: target.event,
    envelope: {
      ...envelope,
      version: target.event.version,
      payload: parsed.data,
    },
    payload: parsed.data,
  };
}
