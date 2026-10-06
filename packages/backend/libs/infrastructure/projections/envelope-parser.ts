import { v5 as uuidv5 } from 'uuid';
import { EventEnvelope, eventEnvelopeSchema } from '@app/infrastructure/events/event-envelope';

const LEGACY_NAMESPACE = '6f1d0c4e-6d4b-4b0e-9a8f-1f6f4b1b7c2a';

export type ParseResult = { ok: true; envelope: EventEnvelope } | { ok: false; reason: string };

/**
 * Accepts F-05 envelopes and the pre-F-05 outbox shape
 * (`{ payload, extra, error }` published by the legacy payment/product code),
 * which is lifted into an envelope with version 0 so old producers keep
 * working while they migrate. Anything else is a poison message.
 */
export function parseEnvelope(topic: string, key: string | null, value: Buffer | null, offset: string): ParseResult {
  if (!value) return { ok: false, reason: 'empty message value (tombstone)' };

  let raw: unknown;
  try {
    raw = JSON.parse(value.toString('utf8'));
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${(error as Error).message}` };
  }

  const parsed = eventEnvelopeSchema.safeParse(raw);
  if (parsed.success) return { ok: true, envelope: parsed.data as EventEnvelope };

  const legacy = raw as { payload?: Record<string, unknown> } | null;
  if (legacy && typeof legacy === 'object' && 'payload' in legacy) {
    const aggregateType = topic.replace(/\.events$/, '');
    const aggregateId =
      (legacy.payload?.productId as string | undefined) ??
      (legacy.payload?.aggregateId as string | undefined) ??
      key ??
      `${topic}:${offset}`;
    return {
      ok: true,
      envelope: {
        // Deterministic id → redelivery of the same message dedupes the same way as a real envelope.
        eventId: uuidv5(`${topic}:${key}:${offset}`, LEGACY_NAMESPACE),
        eventName: `${aggregateType}.legacy`,
        aggregateType,
        aggregateId,
        version: 0,
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        payload: legacy,
      },
    };
  }

  return { ok: false, reason: `not an event envelope: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
}
