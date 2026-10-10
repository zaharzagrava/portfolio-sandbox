/**
 * Who a request speaks for (S48 FR-020). Resolved once per request by the credentials guard; the upstream client
 * attaches identity from here and nowhere else.
 */
export type Credentials =
  | { kind: 'anonymous'; anonymousId?: string }
  | { kind: 'bearer'; token: string; anonymousId?: string }
  | {
      kind: 'session';
      /** Server-side access token of the session; never leaves the BFF. */
      accessToken: string;
      /** Store key (hash of the cookie value): isolates single flight and caches per session. */
      sessionKey: string;
      sessionId: string;
      anonymousId?: string;
    };

export const tokenOf = (credentials: Credentials): string | undefined =>
  credentials.kind === 'bearer'
    ? credentials.token
    : credentials.kind === 'session'
      ? credentials.accessToken
      : undefined;

/** 8..64 of `[A-Za-z0-9_-]`; anything else is ignored, never forwarded (AS-21). */
export const ANONYMOUS_ID = /^[A-Za-z0-9_-]{8,64}$/;
