import { invalidCursor } from './errors';

/**
 * Opaque keyset cursor for invoice lists (S17 FR-051): `base64url(json)` of `{v, c, i}` — version tag, `createdAt`
 * (microsecond text, as the store keeps it: milliseconds would skip or repeat rows created within one millisecond)
 * and `id` of the last item. It is not a secret and not a capability: every query puts the subject in the predicate,
 * so a forged cursor can only move within the caller's own invoices. A cursor that is not exactly this shape is
 * `400 invalid_cursor` and is never followed.
 */
export interface InvoiceCursor {
  /** `2026-04-10T12:00:00.123456Z`. */
  createdAt: string;
  id: string;
}

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(cursor: InvoiceCursor): string {
  return Buffer.from(
    JSON.stringify({ v: VERSION, c: cursor.createdAt, i: cursor.id }),
  ).toString('base64url');
}

export function decodeCursor(raw: unknown): InvoiceCursor {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500)
    throw invalidCursor();
  let parsed: unknown;
  try {
    const bytes = Buffer.from(raw, 'base64url');
    // Only the exact encoding we issue: trailing characters or a different alphabet decode "successfully" otherwise.
    if (bytes.toString('base64url') !== raw) throw invalidCursor();
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const p = parsed as { v?: unknown; c?: unknown; i?: unknown } | null;
  if (
    !p ||
    typeof p !== 'object' ||
    p.v !== VERSION ||
    typeof p.c !== 'string' ||
    !ISO.test(p.c) ||
    Number.isNaN(Date.parse(p.c)) ||
    typeof p.i !== 'string' ||
    !UUID.test(p.i)
  )
    throw invalidCursor();
  return { createdAt: p.c, id: p.i };
}
