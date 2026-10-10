import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { BFF_COOKIES, BFF_CSRF_HEADER } from '@marketplace-sandbox/contracts';
import { BffSettings } from '../bff-config';
import { readCookie } from '../credentials/request-credentials';
import { BffProblem } from '../problem';
import { verifyCsrfRequest } from './csrf-token';

/** The CSRF binding id of a session: the hash of its cookie value (no store lookup needed to check a token). */
export const csrfSessionId = (cookie: string): string =>
  createHash('sha256').update(cookie).digest('hex');

/**
 * Origin and CSRF rules (S48 FR-043, research R-6). Used by the session controller and by the GraphQL endpoint for
 * cookie-authenticated `POST`s; bearer-only and `GET` requests have nothing to protect and are exempt.
 */
@Injectable()
export class RequestGuards {
  constructor(private readonly settings: BffSettings) {}

  /** A present `Origin` must be allowed; without it the fetch metadata must not say cross-site (login CSRF). */
  assertOrigin(req: Request): void {
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      if (!this.settings.allowedOrigins.includes(origin))
        throw new BffProblem('origin_not_allowed');
      return;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw new BffProblem('origin_not_allowed');
  }

  /** A cookie-authenticated state-changing request: allowed origin and a valid, session-bound CSRF token. */
  assertCsrf(req: Request): void {
    if (typeof req.headers.origin === 'string') this.assertOrigin(req);
    const session = readCookie(req, BFF_COOKIES.session);
    if (!session) return;
    const header = req.headers[BFF_CSRF_HEADER];
    const ok = verifyCsrfRequest(
      this.settings.csrfKey,
      csrfSessionId(session),
      typeof header === 'string' ? header : undefined,
      readCookie(req, BFF_COOKIES.csrf),
    );
    if (!ok) throw new BffProblem('csrf_invalid');
  }

  /** Both the session cookie and an `Authorization` header: refuse before anything else (AS-60). */
  assertNotAmbiguous(req: Request): void {
    if (readCookie(req, BFF_COOKIES.session) && req.headers.authorization)
      throw new BffProblem('ambiguous_credentials');
  }
}

/** Login and the second-factor step: origin check (they start from no session, so there is no CSRF token yet). */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly guards: RequestGuards) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    this.guards.assertNotAmbiguous(req);
    this.guards.assertOrigin(req);
    return true;
  }
}

/** Cookie-authenticated `POST`s: origin and CSRF token. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly guards: RequestGuards) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    this.guards.assertNotAmbiguous(req);
    this.guards.assertCsrf(req);
    return true;
  }
}

/** `GET`s of the session controller: only the ambiguity rule applies. */
@Injectable()
export class AmbiguityGuard implements CanActivate {
  constructor(private readonly guards: RequestGuards) {}
  canActivate(context: ExecutionContext): boolean {
    this.guards.assertNotAmbiguous(
      context.switchToHttp().getRequest<Request>(),
    );
    return true;
  }
}
