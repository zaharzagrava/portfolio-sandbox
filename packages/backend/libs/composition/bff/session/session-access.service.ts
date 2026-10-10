import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BffProblem } from '../problem';
import { SessionAccess, SessionLookup } from '../credentials/session-access';
import { csrfSessionId } from './csrf-origin.guard';
import { RefreshCoordinator, SessionEndedError } from './refresh-coordinator';
import { sessionCookies } from './session-cookies';
import { SessionManager } from './session-manager';

/**
 * What the credentials guard asks for: the access token behind a session cookie, refreshed when it is about to
 * expire (S48 FR-046, FR-048). Unknown and expired sessions are anonymous visitors with cleared cookies; a session that
 * this very request ended is a `401 session_expired`; a store that is down is a `503`, never a silent downgrade.
 */
@Injectable()
export class SessionAccessService extends SessionAccess {
  constructor(
    private readonly sessions: SessionManager,
    private readonly refresh: RefreshCoordinator,
  ) {
    super();
  }

  async lookup(
    cookie: string,
    req: Request,
    res: Response,
  ): Promise<SessionLookup> {
    const loaded = await this.sessions.load(cookie);
    if (loaded.state !== 'active') {
      sessionCookies.clearSession(res);
      return { status: 'unknown' };
    }
    try {
      const record = await this.refresh.ensureFresh(
        cookie,
        loaded.record,
        (req as Request & { clientIp?: string }).clientIp ?? req.ip ?? '',
      );
      return {
        status: 'active',
        accessToken: record.accessToken,
        sessionKey: csrfSessionId(cookie),
        sessionId: record.sessionId,
        userId: record.user.id,
      };
    } catch (error) {
      if (error instanceof SessionEndedError) {
        sessionCookies.clearSession(res);
        if (error.reason === 'store_lost')
          throw new BffProblem('session_unavailable', { retryAfterSeconds: 1 });
        throw new BffProblem('session_expired');
      }
      throw error;
    }
  }
}
