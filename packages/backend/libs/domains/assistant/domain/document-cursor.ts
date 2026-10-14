import { createHmac, timingSafeEqual } from 'node:crypto';
import { invalidCursor } from './knowledge-errors';

/** Ordering key of the document list: `(createdAt DESC, id DESC)`; `createdAt` is the database's microsecond text. */
export interface DocumentCursorKey {
  createdAt: string;
  id: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tag = (key: string, scope: string, body: string) =>
  createHmac('sha256', key)
    .update(`knowledge-cursor:v1:${scope}:${body}`)
    .digest('base64url');

/**
 * Opaque keyset cursor (S47 AS-31): the ordering key of the last item, bound to the list's scope and signed, so a
 * tampered, foreign or hand-made cursor is refused (`400 invalid_cursor`) and never followed into a query.
 */
export function encodeDocumentCursor(
  key: string,
  scope: string,
  at: DocumentCursorKey,
): string {
  if (!TIMESTAMP.test(at.createdAt) || !UUID.test(at.id))
    throw new Error('cursor key is not a timestamp and a uuid');
  const body = Buffer.from(
    JSON.stringify({ c: at.createdAt, i: at.id }),
  ).toString('base64url');
  return `${body}.${tag(key, scope, body)}`;
}

export function decodeDocumentCursor(
  key: string,
  scope: string,
  cursor: string,
): DocumentCursorKey {
  const parts = cursor.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidCursor();
  const [body, given] = parts;
  const expected = Buffer.from(tag(key, scope, body));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw invalidCursor();
  let parsed: { c?: unknown; i?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (
    typeof parsed?.c !== 'string' ||
    typeof parsed?.i !== 'string' ||
    !TIMESTAMP.test(parsed.c) ||
    !UUID.test(parsed.i)
  )
    throw invalidCursor();
  return { createdAt: parsed.c, id: parsed.i };
}
