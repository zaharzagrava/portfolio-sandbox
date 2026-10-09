import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { from, Observable, finalize, mergeMap } from 'rxjs';
import { AppError, ErrorArea } from '@app/common/errors';
import { RateLimiterService } from './rate-limiter.service';
import {
  RATE_LIMIT_POLICIES,
  RateLimitDecision,
  RateLimitPolicyName,
} from './rate-limit.types';
import { RATE_LIMIT_METADATA } from './rate-limit.decorator';

export class Domain_RateLimitedError extends AppError {
  constructor(policy: string, retryAfterMs: number) {
    super({
      status: HttpStatus.TOO_MANY_REQUESTS,
      title: 'Too Many Requests',
      detail: `Rate limit "${policy}" exceeded. Retry in ${Math.ceil(retryAfterMs / 1000)}s.`,
      area: ErrorArea.DOMAIN,
    });
  }
}

type AuthedRequest = Request & {
  user?: { id: string };
  apiKey?: { id: string; shopId: string };
  shopId?: string;
};

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiterService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const policies =
      this.reflector.get<RateLimitPolicyName[]>(
        RATE_LIMIT_METADATA,
        context.getHandler(),
      ) ?? [];
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const res = context.switchToHttp().getResponse<Response>();

    return from(this.enforce(policies, req, res)).pipe(
      mergeMap((releases) =>
        next
          .handle()
          .pipe(finalize(() => releases.forEach((release) => void release()))),
      ),
    );
  }

  private async enforce(
    policies: RateLimitPolicyName[],
    req: AuthedRequest,
    res: Response,
  ) {
    const releases: (() => Promise<void>)[] = [];
    let tightest: RateLimitDecision | undefined;

    for (const name of policies) {
      const policy = RATE_LIMIT_POLICIES[name];
      const subject = this.subject(policy.key, req);

      if (policy.algorithm === 'concurrency') {
        const release = await this.limiter.acquire(name, subject);
        if (!release) {
          await Promise.all(releases.map((r) => r()));
          res.setHeader('Retry-After', '5');
          throw new Domain_RateLimitedError(name, 5_000);
        }
        releases.push(release);
        continue;
      }

      const decision = await this.limiter.check(name, subject);
      if (!tightest || decision.remaining < tightest.remaining)
        tightest = decision;
      if (!decision.allowed) {
        await Promise.all(releases.map((r) => r()));
        this.setHeaders(res, name, decision);
        res.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
        );
        throw new Domain_RateLimitedError(name, decision.retryAfterMs);
      }
    }

    if (tightest) this.setHeaders(res, policies[0], tightest);
    return releases;
  }

  /** IETF draft "RateLimit header fields for HTTP" (draft-06 field names, widely supported by clients). */
  private setHeaders(
    res: Response,
    policyName: RateLimitPolicyName,
    d: RateLimitDecision,
  ) {
    const policy = RATE_LIMIT_POLICIES[policyName];
    res.setHeader(
      'RateLimit-Policy',
      `${policy.limit};w=${Math.round(policy.windowMs / 1000)}`,
    );
    res.setHeader('RateLimit-Limit', String(d.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, d.remaining)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(d.resetMs / 1000)));
  }

  private subject(source: string, req: AuthedRequest): string {
    const ip =
      (req.headers['cf-connecting-ip'] as string) ?? req.ip ?? 'unknown';
    switch (source) {
      case 'ip':
        return `ip:${ip}`;
      case 'user':
        return req.user?.id ? `user:${req.user.id}` : `ip:${ip}`;
      case 'userOrIp':
        return req.user?.id ? `user:${req.user.id}` : `ip:${ip}`;
      case 'apiKey':
        return req.apiKey ? `key:${req.apiKey.id}` : `ip:${ip}`;
      case 'shop':
        return req.apiKey?.shopId ?? req.shopId ?? `ip:${ip}`;
      case 'body.email': {
        // Hash: the email never appears in Redis keys (they show up in monitoring/slowlog).
        const email = String((req.body as { email?: string })?.email ?? '')
          .trim()
          .toLowerCase();
        return `email:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`;
      }
      default:
        return `ip:${ip}`;
    }
  }
}
