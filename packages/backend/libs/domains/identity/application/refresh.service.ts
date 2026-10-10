import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  SESSION_REPOSITORY,
  USER_REPOSITORY,
  type SessionRepository,
  type UserRepository,
} from '../domain/ports';
import { Domain_InvalidRefreshTokenError } from '../domain/errors';
import { AuditService } from './audit.service';
import { IssuedSession, SessionIssuer } from './session-issuer.service';
import { SessionRevocationService } from './session-revocation.service';

/**
 * Refresh-token rotation (FR-030 to FR-035). Every failure is the same `invalid_refresh_token` to the client; a spent
 * token being presented again revokes the whole session, with an audit line and a counter (no grace period).
 */
@Injectable()
export class RefreshService {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly issuer: SessionIssuer,
    private readonly revocation: SessionRevocationService,
    private readonly audit: AuditService,
  ) {}

  async refresh(refreshToken: string): Promise<IssuedSession> {
    const outcome = await this.sessions.rotate(refreshToken, this.clock.now());
    if (!outcome.ok) {
      if (outcome.reason === 'reuse' && outcome.sid) {
        await this.revocation.revokeBySid(outcome.sid, 'refresh_token_reuse');
        this.audit.record('auth.refresh.reuse_detected', {
          sessionId: outcome.sid,
          userId: outcome.userId,
        });
      }
      throw new Domain_InvalidRefreshTokenError();
    }

    const { session } = outcome;
    const user = await this.users.findById(session.userId);
    if (!user) {
      await this.revocation.revokeBySid(session.sid, 'user_deleted');
      throw new Domain_InvalidRefreshTokenError();
    }
    return {
      accessToken: await this.issuer.accessToken(
        user,
        session.sid,
        session.amr ?? ['pwd'],
      ),
      refreshToken: outcome.refreshToken,
      sessionId: session.sid,
      user: { id: user.id, email: user.email, role: user.role },
      delivery: 'body',
    };
  }
}
