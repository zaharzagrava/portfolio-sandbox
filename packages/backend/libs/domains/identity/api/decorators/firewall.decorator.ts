import { applyDecorators, UseGuards } from '@nestjs/common';
import { UserAuthGuard } from '../guards/user-auth.guard';
import { UserAuthOptionalGuard } from '../guards/user-auth-optional.guard';
import { Roles, RolesGuard } from '../guards/roles.guard';
import { Role } from '../../infra/models/user.model';

/**
 * Authentication and role guards of a route. Rate limiting is not decided here (S50): every route gets the default
 * limit, `@RateLimit(...)` names a policy, `@RateLimitExempt(reason)` takes a route out with a stated reason.
 */
export function Firewall(options?: {
  anonymous?: boolean;
  /** Restrict to these roles (ignored for anonymous endpoints). */
  roles?: Role[];
}) {
  const { anonymous, roles } = options || {
    anonymous: false,
  };

  const decorators: MethodDecorator[] = [];
  const guards: any[] = [];

  // Auth filtering
  if (anonymous) {
    guards.push(UserAuthOptionalGuard);
  } else {
    guards.push(UserAuthGuard);

    if (roles?.length) {
      decorators.push(Roles(...roles));
      guards.push(RolesGuard);
    }
  }

  decorators.push(UseGuards(...guards));

  return applyDecorators(...decorators);
}
