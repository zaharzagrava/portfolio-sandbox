import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Role } from '@app/domains/identity';
import { insufficientRole } from '../domain/errors';

/**
 * Only platform roles `ADMIN` and `MODERATOR` use the review routes (S04 FR-031). The platform `RolesGuard` answers a
 * generic `forbidden`; this one answers the stable code `insufficient_role` of FR-100. It runs after the authentication
 * guard of `Firewall` (no user yet means that guard has not decided: it passes and the authentication guard answers 401).
 */
@Injectable()
export class ReviewerRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user as
      { role?: Role } | undefined;
    if (!user) return true;
    if (user.role !== Role.ADMIN && user.role !== Role.MODERATOR)
      throw insufficientRole();
    return true;
  }
}
