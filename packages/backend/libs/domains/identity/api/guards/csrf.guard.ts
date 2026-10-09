import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import * as cookie from 'cookie';
import { timingSafeEqual } from 'node:crypto';

export const CSRF_COOKIE = '__Host-csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Double-submit CSRF protection (lesson 05/01 §3) for endpoints that accept a
 * credential from a cookie (refresh, logout). A cross-site form can make the
 * browser send the cookie but cannot read it to copy it into the header.
 * Requests carrying the refresh token in the body (mobile apps) don't use
 * ambient credentials, so they skip the check.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.body?.refreshToken) return true;

    const cookies = cookie.parse(req.headers.cookie ?? '');
    if (!cookies['__Host-refresh']) return true; // nothing ambient to protect

    const header = String(req.headers[CSRF_HEADER] ?? '');
    const expected = cookies[CSRF_COOKIE] ?? '';
    if (
      !header ||
      header.length !== expected.length ||
      !timingSafeEqual(Buffer.from(header), Buffer.from(expected))
    ) {
      throw new ForbiddenException('CSRF token missing or invalid');
    }
    return true;
  }
}
