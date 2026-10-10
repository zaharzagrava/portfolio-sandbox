/** One list member: `*`, or an entity tag (`"opaque"` / `W/"opaque"`); etagc excludes `"` and space (RFC 9110 §8.8.3). */
const ELEMENT = /^(?:\*|(?:W\/)?"([\x21\x23-\x7E\x80-\xFF]*)")$/;
const ENTITY_TAG = /^(?:W\/)?"([\x21\x23-\x7E\x80-\xFF]*)"$/;

/** Splits a header list on commas that are outside quotes; null when a quote is left open. */
function splitList(header: string): string[] | null {
  const members: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) {
      members.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (quoted) return null;
  members.push(current);
  return members;
}

/** Whether `value` is a well-formed entity tag (strong or weak). */
export function isEntityTag(value: string): boolean {
  return ENTITY_TAG.test(value);
}

/**
 * RFC 9110 §13.1.2 `If-None-Match` against the current validator, by weak comparison (a strong and a weak tag with
 * the same opaque value match). `*` matches any current representation. A malformed header never matches and never
 * throws; empty list members are ignored.
 */
export function matchesIfNoneMatch(
  headerValue: string | undefined,
  etag: string,
): boolean {
  if (typeof headerValue !== 'string') return false;
  const current = ENTITY_TAG.exec(etag);
  if (!current) return false;
  const members = splitList(headerValue);
  if (!members) return false;

  const present = members.map((m) => m.trim()).filter((m) => m.length > 0);
  if (present.length === 0) return false;
  let matched = false;
  for (const member of present) {
    const parsed = ELEMENT.exec(member);
    if (!parsed) return false; // one malformed member makes the whole header unusable
    if (member === '*') {
      if (present.length > 1) return false; // `*` is only valid on its own
      return true;
    }
    if (parsed[1] === current[1]) matched = true;
  }
  return matched;
}
