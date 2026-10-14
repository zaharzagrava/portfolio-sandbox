/** A message body is 1–4,000 Unicode code points after trimming (S24 FR-010, AS-16). Pure. */
export const CHAT_BODY_MAX = 4000;

export type BodyResult = { ok: true; body: string } | { ok: false };

export function normalizeBody(raw: unknown): BodyResult {
  if (typeof raw !== 'string') return { ok: false };
  const body = raw.trim();
  if (body.length === 0) return { ok: false };
  // UTF-16 length is an upper bound of the code point count: only count code points when it could matter
  if (body.length > CHAT_BODY_MAX && [...body].length > CHAT_BODY_MAX) {
    return { ok: false };
  }
  return { ok: true, body };
}
