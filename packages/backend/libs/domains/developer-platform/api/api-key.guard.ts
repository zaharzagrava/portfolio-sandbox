import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { RequestContext } from '@app/infrastructure/context';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import {
  Domain_RateLimitedError,
  Domain_RateLimiterUnavailableError,
} from '@app/infrastructure/rate-limit/rate-limit.errors';
import { formatRetryAfter } from '@app/infrastructure/rate-limit';
import { KeyVerifier, VerifiedKey } from '../application/key-verifier.service';
import { apiMetrics } from '../application/metrics';
import type { ApiScope } from '../domain/api-key-format';
import { invalidApiKey } from '../domain/errors';
import { ContentGuard } from './content.guard';
import { LifecycleGuard } from './lifecycle.guard';
import { QuotaGuard } from './quota.guard';
import { ScopeGuard, SCOPES_METADATA } from './scope.guard';
import { VersionGuard } from './version.guard';

export type ApiKeyRequest = {
  headers: Record<string, string | undefined>;
  clientIp?: string;
  apiKey?: VerifiedKey;
  shopId?: string;
};

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * `Authorization: Bearer sk_live_...` (FR-014, FR-018, FR-019). The tenant comes ONLY from the key (never from a path,
 * header or body the client controls) and goes into the request and CLS, so every downstream query, log and event is
 * scoped to it (OWASP API1). Every refusal of a credential is the same `401`; each failure is charged to the client
 * address (30 a minute, fail closed) and counted by reason, never written to a shop's log.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly verifier: KeyVerifier,
    private readonly context: RequestContext,
    private readonly limiter: RateLimiterService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ApiKeyRequest>();
    const header = req.headers.authorization;
    const raw = header ? BEARER.exec(header)?.[1] : undefined;
    const outcome = raw ? await this.verifier.check(raw) : null;
    if (!outcome || !outcome.ok) {
      await this.chargeFailure(req, outcome ? outcome.reason : 'malformed');
      throw invalidApiKey();
    }
    req.apiKey = outcome.key;
    req.shopId = outcome.key.shopId;
    this.context.set('shopId', outcome.key.shopId);
    return true;
  }

  private async chargeFailure(
    req: ApiKeyRequest,
    reason: string,
  ): Promise<void> {
    apiMetrics.authFailures().add(1, { reason });
    const decision = await this.limiter.check(
      'public-api.auth-failure.ip',
      `ip:${req.clientIp || 'unknown'}`,
    );
    if (decision.allowed) return;
    if (decision.reason === 'store-unavailable')
      throw new Domain_RateLimiterUnavailableError();
    throw new Domain_RateLimitedError(
      Number(formatRetryAfter(decision.retryAfterMs ?? 1000)),
    );
  }
}

/** Authentication, then the shop's lifecycle, then the route's scope (FR-015, FR-017). */
export const ApiKeyAuth = (...scopes: ApiScope[]) =>
  applyDecorators(
    SetMetadata(SCOPES_METADATA, scopes),
    UseGuards(
      ApiKeyGuard,
      LifecycleGuard,
      VersionGuard,
      ContentGuard,
      ScopeGuard,
      QuotaGuard,
    ),
  );
