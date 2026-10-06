import { applyDecorators, CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '@app/infrastructure/context/request-context.service';
import { ApiKeysService, VerifiedKey } from '../application/api-keys.service';
import type { ApiScope } from '../domain/api-key-format';

const SCOPES = 'publicApi:scopes';

export type ApiKeyRequest = { headers: Record<string, string | undefined>; apiKey?: VerifiedKey; shopId?: string };

/**
 * `Authorization: Bearer sk_live_...`. The tenant comes ONLY from the key
 * (never from a path or header the client controls) and goes into CLS, so
 * every downstream query/log/event is scoped to it (BOLA, OWASP API1).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly reflector: Reflector,
    private readonly context: RequestContext,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ApiKeyRequest>();
    const raw = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const key = raw ? await this.keys.verify(raw) : null;
    if (!key) throw new UnauthorizedException({ type: 'invalid_api_key', message: 'Invalid, expired or revoked API key' });

    const required = this.reflector.get<ApiScope[] | undefined>(SCOPES, ctx.getHandler()) ?? [];
    const missing = required.filter((s) => !key.scopes.includes(s));
    if (missing.length) throw new ForbiddenException({ type: 'insufficient_scope', message: `Key lacks scope(s): ${missing.join(', ')}` });

    req.apiKey = key;
    req.shopId = key.shopId;
    this.context.set('shopId', key.shopId);
    return true;
  }
}

export const ApiKeyAuth = (...scopes: ApiScope[]) => applyDecorators(SetMetadata(SCOPES, scopes), UseGuards(ApiKeyGuard));
