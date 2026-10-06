import { applyDecorators, UseGuards } from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { UserAuthGuard } from '../guards/user-auth.guard';
import { UserAuthOptionalGuard } from '../guards/user-auth-optional.guard';
import { Roles, RolesGuard } from '../guards/roles.guard';
import { Role } from '../../infra/models/user.model';

export function Firewall(options?: {
  anonymous?: boolean;
  throttle?: { limit: number; ttl: number };
  skipThrottle?: boolean;
  /** Restrict to these roles (ignored for anonymous endpoints). */
  roles?: Role[];
}) {
  const { throttle, anonymous, skipThrottle, roles } = options || {
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

  if (skipThrottle) {
    decorators.push(SkipThrottle());
  } else if (throttle) {
    decorators.push(
      Throttle({
        asd: {
          limit: throttle.limit,
          ttl: throttle.ttl,
        },
      }),
    );
  }

  return applyDecorators(...decorators);
}
