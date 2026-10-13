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

/** Session first (`401`), then the role (`403`). */
export const AdminOnly = () =>
  applyDecorators(Firewall(), UseGuards(AdminRoleGuard));
