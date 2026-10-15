import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { Firewall, Role } from '@app/domains/identity';
import { permissionDenied } from '../domain/errors';

/** The platform `admin` role only; anyone else answers `403 permission_denied` with no data. */
@Injectable()
class AdminRoleGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const user = ctx
      .switchToHttp()
      .getRequest<{ user?: { role?: string } }>().user;
    if (user?.role !== Role.ADMIN) throw permissionDenied();
    return true;
  }
}

/** Session first (`401`), then the role (`403`); revocation is checked on every call (catalog writes are sensitive). */
export const AdminOnly = () =>
  applyDecorators(Firewall({ sensitive: true }), UseGuards(AdminRoleGuard));
