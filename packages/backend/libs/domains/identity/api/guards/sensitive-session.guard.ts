import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import {
  Domain_InvalidTokenError,
  Domain_RevocationCheckUnavailableError,
} from '../../domain/errors';
import { RevocationMarkers } from '../../infra/sessions/revocation-markers';

/**
 * For sensitive operations (change password, payouts, API keys, log out everywhere): besides a valid token, the
 * session must not be revoked. Ordinary routes accept a revoked session's token until it expires (≤ 300 s); this adds
 * one Redis EXISTS where instant revocation matters, and refuses when it cannot check (FR-025).
 */
@Injectable()
export class SensitiveSessionGuard implements CanActivate {
  constructor(private readonly markers: RevocationMarkers) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const sid = context.switchToHttp().getRequest().user?.sessionId as
      string | undefined;
    if (!sid) throw new Domain_InvalidTokenError('no_session');
    let revoked: boolean;
    try {
      revoked = await this.markers.isRevoked(sid);
    } catch {
      throw new Domain_RevocationCheckUnavailableError();
    }
    if (revoked) throw new Domain_InvalidTokenError('session_revoked');
    return true;
  }
}
