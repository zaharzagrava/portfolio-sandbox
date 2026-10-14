import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiScope } from '../domain/api-key-format';
import { insufficientScope } from '../domain/errors';
import type { VerifiedKey } from '../application/key-verifier.service';

export const SCOPES_METADATA = 'publicApi:scopes';

/** The route's declared scope, checked after authentication and before any work (FR-015): `403 insufficient_scope`. */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ apiKey?: VerifiedKey }>();
    const required =
      this.reflector.get<ApiScope[] | undefined>(
        SCOPES_METADATA,
        ctx.getHandler(),
      ) ?? [];
    const missing = required.filter((s) => !req.apiKey?.scopes.includes(s));
    if (missing.length > 0) throw insufficientScope(missing);
    return true;
  }
}
