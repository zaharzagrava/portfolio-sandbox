import { applyDecorators, UseGuards } from '@nestjs/common';
import { UserAuthGuard } from '../guards/user-auth.guard';
import { UserAuthOptionalGuard } from '../guards/user-auth-optional.guard';
import { SensitiveSessionGuard } from '../guards/sensitive-session.guard';
import { Roles, RolesGuard } from '../guards/roles.guard';
import { Role } from '../../infra/models/user.model';

/**
 * Authentication and role guards of a route. Rate limiting is not decided here (S50): every route gets the default
 * limit, `@RateLimit(...)` names a policy, `@RateLimitExempt(reason)` takes a route out with a stated reason.
 * `sensitive` also rejects tokens of a revoked session immediately.
 */
export function Firewall(options?: {
  anonymous?: boolean;
  /** Restrict to these roles (ignored for anonymous endpoints). */
  roles?: Role[];
  /** Reject a revoked session at once and fail closed when the revocation store is unreachable. */
  sensitive?: boolean;
}) {
  const { anonymous, roles, sensitive } = options || {
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
    if (sensitive) guards.push(SensitiveSessionGuard);
  }

  decorators.push(UseGuards(...guards));

  return applyDecorators(...decorators);
}
