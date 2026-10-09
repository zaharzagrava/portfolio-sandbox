import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../infra/models/user.model';

export const ROLES_METADATA_KEY = 'firewall:roles';
export const Roles = (...roles: Role[]) =>
  SetMetadata(ROLES_METADATA_KEY, roles);

/** Runs after UserAuthGuard, so `request.user` is already populated. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!roles?.length) return true;

    const user = context.switchToHttp().getRequest().user;
    if (!user || !roles.includes(user.role)) {
      throw new ForbiddenException(
        `Requires one of roles: ${roles.join(', ')}`,
      );
    }

    return true;
  }
}
