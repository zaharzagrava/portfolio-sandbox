import { Injectable } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import type { IssuedSession } from '../application/session-issuer.service';
import { REFRESH_IDLE_SEC } from '../domain/session-policy';

export const ACCESS_COOKIE = '__Host-access';
export const REFRESH_COOKIE = '__Host-refresh';
export const CSRF_COOKIE_NAME = '__Host-csrf';
export const MFA_CHALLENGE_COOKIE = '__Host-mfa-challenge';
export const OIDC_FLOW_COOKIE = '__Host-oidc-flow';

const base = (httpOnly: boolean, maxAgeSec: number): CookieOptions => ({
  httpOnly,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: maxAgeSec * 1000,
});

const clearing = (): CookieOptions => {
  const { maxAge: _maxAge, ...rest } = base(true, 0);
  return rest;
};

/**
 * The one writer of the credential cookies (S01 FR-050): `__Host-access` and `__Host-refresh` (HttpOnly) and the
 * readable `__Host-csrf`, all `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`. Tokens never appear in the body of a
 * cookie-delivered session. S02 writes the challenge and flow cookies here too, so every cookie of the auth flows
 * has one set of attributes.
 */
@Injectable()
export class CredentialCookies {
  constructor(private readonly config: ApiConfigService) {}

  /** Cookie delivery of an issued session; `body` is what remains for the response (no tokens). */
  set(res: Response, issued: IssuedSession) {
    res.cookie(
      ACCESS_COOKIE,
      issued.accessToken.token,
      base(true, issued.accessToken.expiresIn),
    );
    res.cookie(
      REFRESH_COOKIE,
      issued.refreshToken,
      base(true, REFRESH_IDLE_SEC),
    );
    res.cookie(
      CSRF_COOKIE_NAME,
      this.csrfToken(issued.sessionId),
      base(false, REFRESH_IDLE_SEC),
    );
    return {
      sessionId: issued.sessionId,
      user: issued.user,
      accessTokenExpiresIn: issued.accessToken.expiresIn,
    };
  }

  setChallenge(res: Response, token: string): void {
    res.cookie(MFA_CHALLENGE_COOKIE, token, base(true, 300));
  }

  clearChallenge(res: Response): void {
    res.clearCookie(MFA_CHALLENGE_COOKIE, clearing());
  }

  setFlow(res: Response, value: string): void {
    res.cookie(OIDC_FLOW_COOKIE, value, base(true, 600));
  }

  clearFlow(res: Response): void {
    res.clearCookie(OIDC_FLOW_COOKIE, clearing());
  }

  /** A random part and a keyed MAC over the session and that part: bound to the session (S01 FR-051). */
  private csrfToken(sessionId: string): string {
    const random = randomBytes(24).toString('base64url');
    const mac = createHmac('sha256', this.config.get('jwt_secret'))
      .update(`csrf:${sessionId}:${random}`)
      .digest('base64url');
    return `${random}.${mac}`;
  }
}
