/**
 * Opaque keyset cursors (S25 D1, FR-030). A cursor carries the last position of a list, the kind of list and its
 * scope (board+sort+window, post, comment), and a signature, so a client can neither edit it nor use it on another
 * list. The signing function is injected (infrastructure binds an HMAC with the configured secret).
 */
export type CursorKind = 'hot' | 'top' | 'new' | 'best' | 'old' | 'replies';

export interface CursorScope {
  kind: CursorKind;
  scope: string;
}

export interface CursorPayload extends CursorScope {
  position: string;
}

export interface CursorCodec {
  encode(payload: CursorPayload): string;
  /** The position when the cursor is well-formed, correctly signed and issued for `expected`; otherwise `null`. */
  decode(token: string, expected: CursorScope): string | null;
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const unb64 = (text: string) => Buffer.from(text, 'base64url').toString('utf8');

const sameSignature = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export function createCursorCodec(sign: (data: string) => string): CursorCodec {
  return {
    encode({ kind, scope, position }) {
      const body = b64(JSON.stringify([kind, scope, position]));
      return `${body}.${sign(body)}`;
    },
    decode(token, expected) {
      const dot = token.lastIndexOf('.');
      if (dot <= 0 || dot === token.length - 1) return null;
      const body = token.slice(0, dot);
      if (!sameSignature(token.slice(dot + 1), sign(body))) return null;
      try {
        const parsed: unknown = JSON.parse(unb64(body));
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 3 ||
          parsed.some((p) => typeof p !== 'string')
        )
          return null;
        const [kind, scope, position] = parsed as [string, string, string];
        return kind === expected.kind && scope === expected.scope
          ? position
          : null;
      } catch {
        return null;
      }
    },
  };
}
