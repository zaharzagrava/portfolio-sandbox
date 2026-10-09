import {
  EventEnvelope,
  eventEnvelopeSchema,
} from '@app/infrastructure/events/event-envelope';

export type ParseResult =
  | { ok: true; envelope: EventEnvelope }
  | {
      ok: false;
      /** Dead-letter reason code (`contracts/dead-letter.md`). */
      code: 'INVALID_ENVELOPE';
      /** Failure description: schema paths and rule names only, never a value from the message. */
      reason: string;
    };

/**
 * Strict envelope parse (S53 FR-026, G-16): anything that is not an envelope of `contracts/envelope.md` is a poison
 * message, there is no lift of legacy shapes. The reason names schema paths, never values.
 */
export function parseEnvelope(value: Buffer | null): ParseResult {
  if (!value)
    return {
      ok: false,
      code: 'INVALID_ENVELOPE',
      reason: 'empty message value (tombstone)',
    };

  let raw: unknown;
  try {
    raw = JSON.parse(value.toString('utf8'));
  } catch {
    return { ok: false, code: 'INVALID_ENVELOPE', reason: 'value is not JSON' };
  }

  const parsed = eventEnvelopeSchema.safeParse(raw);
  if (parsed.success) return { ok: true, envelope: parsed.data };

  const paths = [
    ...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)')),
  ];
  return {
    ok: false,
    code: 'INVALID_ENVELOPE',
    reason: `not an event envelope, failing at: ${paths.join(', ')}`,
  };
}
