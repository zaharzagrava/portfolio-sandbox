import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { Firewall, Role } from '@app/domains/identity';
import { PermissionDenied } from '../domain/ledger-errors';

/** The platform `admin` role only; anyone else answers `403 permission_denied` with no data (S14 contracts/http.md). */
@Injectable()
class AdminRoleGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const user = ctx
      .switchToHttp()
      .getRequest<{ user?: { role?: string } }>().user;
    if (user?.role !== Role.ADMIN) throw new PermissionDenied();
    return true;
  }
}

/**
 * Session first (`401`), then the role (`403`). `sensitive: true` (S01 follow-up) makes the route check revocation on
 * every call: the finance writes use it, so a revoked admin session is refused at once.
 */
export const AdminOnly = (options: { sensitive?: boolean } = {}) =>
  applyDecorators(
    options.sensitive ? Firewall({ sensitive: true }) : Firewall(),
    UseGuards(AdminRoleGuard),
  );
