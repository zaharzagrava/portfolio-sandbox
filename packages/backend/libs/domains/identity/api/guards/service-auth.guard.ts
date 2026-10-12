import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiConfigService } from '@app/common/config';
import type { ServicePrincipal } from '../../domain/authenticated-user';
import {
  Domain_InvalidTokenError,
  Domain_ServiceCallerNotAllowedError,
} from '../../domain/errors';
import {
  callerAllowed,
  SERVICE_SUBJECT_PREFIX,
  SERVICE_TOKEN_TYP,
} from '../../domain/service-token-policy';
import type { TokenClaims } from '../../domain/token-verifier';
import { TokenAuthService } from '../../application/token-auth.service';

export const ALLOWED_CALLERS_KEY = 'identity:allowed-callers';
export const DEFAULT_SERVICE_AUDIENCE = 'core';

/** The services that may call an internal endpoint (FR-071). An endpoint without it admits no caller. */
export const AllowedCallers = (...callers: string[]) =>
  SetMetadata(ALLOWED_CALLERS_KEY, callers);

function principalOf(claims: TokenClaims): ServicePrincipal {
  const actor = claims.act?.sub;
  if (typeof actor === 'string') {
    // An exchanged token: `sub` is the user, `act.sub` the calling service.
    if (
      !actor.startsWith(SERVICE_SUBJECT_PREFIX) ||
      typeof claims.sid !== 'string'
    )
      throw new Domain_InvalidTokenError('actor');
    return {
      kind: 'service',
      caller: actor.slice(SERVICE_SUBJECT_PREFIX.length),
      onBehalfOf: { userId: claims.sub, sessionId: claims.sid },
    };
  }
  if (
    !claims.sub.startsWith(SERVICE_SUBJECT_PREFIX) ||
    claims.sub.length === SERVICE_SUBJECT_PREFIX.length
  )
    throw new Domain_InvalidTokenError('subject');
  return {
    kind: 'service',
    caller: claims.sub.slice(SERVICE_SUBJECT_PREFIX.length),
  };
}

/**
 * Authenticates a service call (FR-071): a `Bearer` token with `typ: svc+jwt`, verified like every token (ES256,
 * issuer, expiry) and addressed to this app's own audience; then the endpoint's caller allowlist. A user access token,
 * a token for another service and a missing token are all the same `401`; a valid token of an unlisted caller is `403`.
 */
@Injectable()
export class ServiceAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenAuthService,
    private readonly config: ApiConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: unknown }>();
    const authorization = req.headers.authorization;
    if (
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ')
    )
      throw new Domain_InvalidTokenError('missing');
    const claims = await this.tokens.verifyPurpose(
      authorization.slice('Bearer '.length).trim(),
      {
        typ: SERVICE_TOKEN_TYP,
        aud: this.config.get('service_audience') || DEFAULT_SERVICE_AUDIENCE,
      },
    );
    const principal = principalOf(claims);
    const allowed = this.reflector.getAllAndOverride<string[] | undefined>(
      ALLOWED_CALLERS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!allowed || !callerAllowed(principal.caller, allowed))
      throw new Domain_ServiceCallerNotAllowedError();
    req.user = principal;
    return true;
  }
}
