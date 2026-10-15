const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Time-UUID (version 1): conversation ids sort by creation. */
const TIME_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isTimeUuid(value: string): boolean {
  return TIME_UUID.test(value);
}

/** Opaque keyset cursor: base64url of the last conversation id returned. */
export function encodeConversationCursor(lastConversationId: string): string {
  return Buffer.from(lastConversationId, 'utf8').toString('base64url');
}

/** The conversation id inside a cursor, or null when malformed (`400 invalid_cursor`). */
export function decodeConversationCursor(cursor: string): string | null {
  if (!BASE64URL.test(cursor)) return null;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  return isTimeUuid(id) ? id : null;
}
