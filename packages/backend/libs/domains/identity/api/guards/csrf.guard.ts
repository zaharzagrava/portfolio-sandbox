import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import * as cookie from 'cookie';
import type { Request } from 'express';
import { ApiConfigService } from '@app/common/config';
import { SESSION_REPOSITORY, type SessionRepository } from '../../domain/ports';
import { assertCsrf } from './cookie-request';
import { assertOriginAllowed } from './origin.guard';

export { CSRF_COOKIE, CSRF_HEADER } from './cookie-request';

const REFRESH_COOKIE = '__Host-refresh';

/**
 * CSRF and origin protection for the refresh endpoint when the credential is the `__Host-refresh` cookie (FR-051,
 * FR-052, FR-055): the signed double-submit token must be valid for the session the refresh token belongs to. It runs
 * before the handler, so a refused request has consumed nothing. A refresh token in the body is not an ambient
 * credential and skips the check; an unknown cookie token is left to the handler, which answers the uniform 401.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly config: ApiConfigService,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.body?.refreshToken) return true;
    const token = cookie.parse(req.headers.cookie ?? '')[REFRESH_COOKIE];
    if (!token) return true; // nothing ambient to protect

    assertOriginAllowed(req, this.config);
    const sid = await this.sessions.sidOfRefreshToken(token);
    if (sid) assertCsrf(req, this.config, sid);
    return true;
  }
}
