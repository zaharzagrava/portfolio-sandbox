/**
 * The allowlisted route table of the forwarder (W01 B-1, research R-03). Input is the path below `/api/` as the browser
 * sent it (still percent-encoded). Anything that is not an ordinary relative path, and every route that would mint or
 * rotate credentials outside the session endpoints, is refused (`blocked`), so the forwarder can never be used to
 * bypass `/api/bff/session` or to reach another origin.
 */
export type ForwardTarget =
  | {
      kind: 'api' | 'sse';
      /** Path below `/api/`, segments exactly as received. */
      rest: string;
      /** The request body is passed on without the JSON size limit (file uploads keep their upstream limit). */
      streamBody: boolean;
    }
  | { kind: 'blocked' };

const BLOCKED = { kind: 'blocked' } as const;

/** Prefixes served by the SSE gateway origin. Segments are compared decoded and lower-cased. */
const isSse = (segments: string[]): boolean => {
  const [first, , third] = segments;
  if (first === 'streams' || first === 'assistant') return true;
  if (first === 'payment' && segments[1] === 'stream') return true;
  return first === 'live' && third === 'events';
};

/** Routes whose answer carries tokens or whose purpose is to start, rotate or end a credential. */
const isCredentialRoute = (segments: string[]): boolean => {
  const [first, second, third] = segments;
  if (first === 'bff' || first === 'graphql') return true;
  if (first !== 'auth') return false;
  if (second === 'login' || second === 'refresh' || second === 'logout')
    return true;
  return second === 'mfa' && third === 'verify';
};

const STREAMING_BODY = new Set(['assets', 'uploads']);

const hasForbiddenChar = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x5c || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

export function resolveForwardTarget(rest: string): ForwardTarget {
  if (rest === '' || hasForbiddenChar(rest)) return BLOCKED;
  const raw = rest.split('/');
  const segments: string[] = [];
  for (const part of raw) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return BLOCKED;
    }
    if (
      decoded === '' ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\')
    )
      return BLOCKED;
    segments.push(decoded.toLowerCase());
  }
  if (isCredentialRoute(segments)) return BLOCKED;
  return {
    kind: isSse(segments) ? 'sse' : 'api',
    rest,
    streamBody: STREAMING_BODY.has(segments[0]),
  };
}
