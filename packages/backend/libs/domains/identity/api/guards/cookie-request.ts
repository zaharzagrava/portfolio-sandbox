import type { ExecutionContext } from '@nestjs/common';
import * as cookie from 'cookie';
import type { Request } from 'express';
import { ApiConfigService } from '@app/common/config';
import { verifyCsrfToken } from '../../domain/csrf-token';
import { Domain_CsrfInvalidError } from '../../domain/errors';
import { assertOriginAllowed } from './origin.guard';

export const CSRF_COOKIE = '__Host-csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `true` when the request's credential is the ambient `__Host-access` cookie (no `Authorization: Bearer`). */
export function usesCookieCredential(req: Request): boolean {
  const authorization = req.headers.authorization;
  return !(
    typeof authorization === 'string' && authorization.startsWith('Bearer ')
  );
}

/** The CSRF check (signed double-submit bound to `sid`, FR-051) for a request whose credential is a cookie. */
export function assertCsrf(
  req: Request,
  config: ApiConfigService,
  sid: string,
): void {
  const cookies = cookie.parse(req.headers.cookie ?? '');
  const header = req.headers[CSRF_HEADER];
  if (
    !verifyCsrfToken({
      secret: config.get('jwt_secret'),
      sid,
      header: typeof header === 'string' ? header : '',
      cookie: cookies[CSRF_COOKIE] ?? '',
    })
  )
    throw new Domain_CsrfInvalidError();
}

/**
 * A state-changing request authenticated by the access cookie must come from an allowed origin and carry a CSRF
 * token for its session (FR-051, FR-052). Bearer requests carry no ambient credential and are exempt.
 */
export function assertCookieRequestAllowed(
  context: ExecutionContext,
  config: ApiConfigService,
  sid: string,
): void {
  const req = context.switchToHttp().getRequest<Request>();
  if (SAFE_METHODS.has(req.method) || !usesCookieCredential(req)) return;
  assertOriginAllowed(req, config);
  assertCsrf(req, config, sid);
}
