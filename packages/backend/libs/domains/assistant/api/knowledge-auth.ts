import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { Firewall } from '@app/domains/identity';
import { invalidToken } from '../domain/knowledge-errors';

const ACCESS_COOKIE = '__Host-access';

/** Whether the request carries a credential at all (the bearer header, or the access cookie of cookie delivery). */
function presentsCredentials(req: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const authorization = req.headers['authorization'];
  if (
    typeof authorization === 'string' &&
    authorization.startsWith('Bearer ') &&
    authorization.slice('Bearer '.length).trim()
  )
    return true;
  const cookie = req.headers.cookie;
  return typeof cookie === 'string' && cookie.includes(`${ACCESS_COOKIE}=`);
}

/**
 * Runs after the optional authentication, which degrades a bad token to "no user": a request that PRESENTED credentials
 * and still has no user is refused with `401 invalid_token` (S47 AS-02: an invalid or expired token is not anonymous).
 */
@Injectable()
export class RejectBadCredentialsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (presentsCredentials(req) && !req.user) throw invalidToken();
    return true;
  }
}

/** Anonymous buyers are served; a presented credential must be valid. Declare request validation ABOVE this one. */
export const AnonymousOrAuthenticated = () =>
  applyDecorators(
    Firewall({ anonymous: true }),
    UseGuards(RejectBadCredentialsGuard),
  );
