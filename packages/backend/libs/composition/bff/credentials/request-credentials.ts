import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BFF_COOKIES } from '@marketplace-sandbox/contracts';
import { BffProblem } from '../problem';
import { ANONYMOUS_ID, Credentials } from './credentials';
import { SessionAccess } from './session-access';

export type RequestWithCredentials = Request & {
  credentials?: Credentials;
  user?: { id: string };
};

/** `Cookie` header → value of one cookie (no decoding: the session value is base64url). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name)
      return part.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * Resolves who a request speaks for (S48 FR-020, AS-60, AS-61): the session cookie (server-side token), an
 * `Authorization: Bearer` header (native clients, forwarded unchanged), or nobody. Both at once is a 400; an unknown
 * cookie is served as anonymous; a session store that is down is a 503, never a silent downgrade.
 */
@Injectable()
export class RequestCredentials {
  constructor(private readonly sessions: SessionAccess) {}

  async resolve(
    req: RequestWithCredentials,
    res: Response,
  ): Promise<Credentials> {
    const cookie = readCookie(req, BFF_COOKIES.session);
    const authorization = req.headers.authorization;
    if (cookie && authorization) throw new BffProblem('ambiguous_credentials');

    const rawAnonymous = req.headers['x-anonymous-id'];
    const anonymousId =
      typeof rawAnonymous === 'string' && ANONYMOUS_ID.test(rawAnonymous)
        ? rawAnonymous
        : undefined;

    if (cookie) {
      const found = await this.sessions.lookup(cookie, req, res);
      if (found.status === 'active') {
        req.user = { id: found.userId };
        return {
          kind: 'session',
          accessToken: found.accessToken,
          sessionKey: found.sessionKey,
          sessionId: found.sessionId,
          anonymousId,
        };
      }
      return { kind: 'anonymous', anonymousId };
    }
    const bearer = authorization && /^Bearer\s+(\S+)$/i.exec(authorization);
    if (bearer) return { kind: 'bearer', token: bearer[1], anonymousId };
    return { kind: 'anonymous', anonymousId };
  }
}
