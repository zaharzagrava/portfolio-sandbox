import type { Request, Response } from 'express';

/** What the credentials guard needs from the session slice: the access token behind a cookie, kept fresh. */
export type SessionLookup =
  | {
      status: 'active';
      accessToken: string;
      sessionKey: string;
      sessionId: string;
      userId: string;
    }
  /** No such session (never existed, expired, logged out, forged): serve the request as anonymous. */
  | { status: 'unknown' };

/**
 * Implemented by `session/session-access.service.ts`. Throws `BffProblem('session_unavailable')` when the store is
 * down and `BffProblem('session_expired')` when this very request ended the session (refresh rejected).
 */
export abstract class SessionAccess {
  abstract lookup(
    cookieValue: string,
    req: Request,
    res: Response,
  ): Promise<SessionLookup>;
}
