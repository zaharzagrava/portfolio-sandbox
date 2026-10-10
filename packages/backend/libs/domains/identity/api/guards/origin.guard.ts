import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiConfigService } from '@app/common/config';
import { Domain_OriginNotAllowedError } from '../../domain/errors';

/** The origins a browser may call the credential endpoints from: the web app and the configured CORS allowlist. */
export function allowedOrigins(config: ApiConfigService): Set<string> {
  const origins = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    try {
      origins.add(new URL(value.trim()).origin);
    } catch {
      /* not a URL: not an origin */
    }
  };
  add(config.get('front_host'));
  for (const o of (config.get('cors_allowed_origins') ?? '').split(',')) add(o);
  return origins;
}

/**
 * Cookie-delivery logins and flow starts must come from an allowed origin (S01 FR-052): `Origin` in the allowlist, or,
 * when the browser sent none, `Sec-Fetch-Site` not `cross-site`. Runs before the handler, so a refused request has
 * consumed nothing (a challenge, a flow record).
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly config: ApiConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      if (!allowedOrigins(this.config).has(origin))
        throw new Domain_OriginNotAllowedError();
      return true;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw new Domain_OriginNotAllowedError();
    return true;
  }
}

/** For handlers that only need the check on some requests (cookie delivery decided by the body). */
export function assertOriginAllowed(
  req: Request,
  config: ApiConfigService,
): void {
  new OriginGuard(config).canActivate({
    switchToHttp: () => ({ getRequest: () => req }),
  } as ExecutionContext);
}
