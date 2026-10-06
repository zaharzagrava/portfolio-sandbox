import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SessionStore } from '../../infra/sessions/session-store.service';

/**
 * For sensitive operations (change password, payouts, API key creation):
 * besides a valid signature, the session must not be revoked. Access tokens
 * are short-lived and verified locally (no I/O) everywhere else; this adds one
 * Redis EXISTS only where instant revocation matters.
 */
@Injectable()
export class SessionNotRevokedGuard implements CanActivate {
  constructor(private readonly sessions: SessionStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const sid = context.switchToHttp().getRequest().user?.sessionId as string | undefined;
    // Legacy tokens (no session) are rejected for sensitive operations.
    if (!sid || (await this.sessions.isRevoked(sid))) throw new UnauthorizedException('Session revoked or not session-bound');
    return true;
  }
}
