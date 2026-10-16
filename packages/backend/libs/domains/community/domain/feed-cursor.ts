/**
 * Opaque, signed keyset cursors of the feed and the following list (S26 D1, FR-040, FR-007). A cursor carries the last
 * position of one list; the list is part of the signed body, so a cursor of the other list, an edited one or a malformed
 * one decodes to `null`. The signing function is injected (infrastructure binds an HMAC with the configured secret).
 */
export interface FeedCursorPosition {
  /** Milliseconds of the last item returned. */
  ms: number;
  /** Sortable item id of the last item returned (tiebreak). */
  itemId: string;
}

export interface FollowingCursorPosition {
  followedAtMs: number;
  accountId: string;
}

export interface FeedCursorCodec {
  encodeFeed(position: FeedCursorPosition): string;
  decodeFeed(token: string): FeedCursorPosition | null;
  encodeFollowing(position: FollowingCursorPosition): string;
  decodeFollowing(token: string): FollowingCursorPosition | null;
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const unb64 = (text: string) => Buffer.from(text, 'base64url').toString('utf8');

const sameSignature = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const validMs = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function createFeedCursorCodec(
  sign: (data: string) => string,
): FeedCursorCodec {
  const encode = (parts: unknown[]) => {
    const body = b64(JSON.stringify(parts));
    return `${body}.${sign(body)}`;
  };
  const decode = (token: string, list: string): unknown[] | null => {
    const dot = token.lastIndexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;
    const body = token.slice(0, dot);
    if (!sameSignature(token.slice(dot + 1), sign(body))) return null;
    try {
      const parsed: unknown = JSON.parse(unb64(body));
      return Array.isArray(parsed) && parsed.length === 3 && parsed[0] === list
        ? parsed
        : null;
    } catch {
      return null;
    }
  };
  return {
    encodeFeed: ({ ms, itemId }) => encode(['feed', ms, itemId]),
    decodeFeed(token) {
      const p = decode(token, 'feed');
      if (!p || !validMs(p[1]) || typeof p[2] !== 'string' || !p[2])
        return null;
      return { ms: p[1], itemId: p[2] };
    },
    encodeFollowing: ({ followedAtMs, accountId }) =>
      encode(['following', followedAtMs, accountId]),
    decodeFollowing(token) {
      const p = decode(token, 'following');
      if (!p || !validMs(p[1]) || typeof p[2] !== 'string' || !p[2])
        return null;
      return { followedAtMs: p[1], accountId: p[2] };
    },
  };
}
