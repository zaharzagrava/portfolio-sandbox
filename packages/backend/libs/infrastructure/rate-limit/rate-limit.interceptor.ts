import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import {
  Observable,
  catchError,
  finalize,
  from,
  mergeMap,
  throwError,
} from 'rxjs';
import { normalizeHttpCost } from './cost';
import { defaultEntryFor } from './default-rate-limit';
import { PolicyRegistry } from './policy-registry';
import {
  RATE_LIMIT_EXEMPT_METADATA,
  RATE_LIMIT_METADATA,
} from './rate-limit.metadata';
import type { RateLimitRouteOptions } from './rate-limit.decorator';
import {
  Domain_RateLimitCostExceededError,
  Domain_RateLimitedError,
  Domain_RateLimiterUnavailableError,
} from './rate-limit.errors';
import {
  formatRetryAfter,
  headersFor,
  type HeaderItem,
} from './rate-limit-headers';
import { RateLimitDenialLog } from './rate-limit-denial-log';
import { RateLimitMetrics } from './rate-limit.metrics';
import { RateLimiterService } from './rate-limiter.service';
import type { RateLimitDecision, RateLimitPolicy } from './rate-limit.types';
import { resolveSubject, type SubjectRequest } from './subject';

type LimitedRequest = Request &
  SubjectRequest & { clientIp?: string; requestId?: string };

interface Evaluated {
  entry: RateLimitRouteOptions;
  policy: RateLimitPolicy;
  subject: string;
  cost: number;
  decision: RateLimitDecision;
  release?: () => Promise<void>;
}

interface Admission {
  taken: Evaluated[];
}

const DEFAULT_FAILURE_STATUSES: readonly number[] = [401, 403];

export const RATE_LIMIT_ROOT_OPTIONS = Symbol('RATE_LIMIT_ROOT_OPTIONS');

const statusOf = (error: unknown): number => {
  if (error instanceof HttpException) return error.getStatus();
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 500;
};

/**
 * The one HTTP-side enforcement point (FR-025): a global interceptor, so it runs after the guards, before the pipes and
 * before every route-scoped interceptor (idempotency included), whatever the order of the decorators on a route.
 * Explicit `@RateLimit(...)` policies, else the default for the method, unless the route is exempt.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly logger = new Logger('RateLimit');

  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiterService,
    private readonly registry: PolicyRegistry,
    private readonly metrics: RateLimitMetrics,
    private readonly denialLog: RateLimitDenialLog,
    @Inject(RATE_LIMIT_ROOT_OPTIONS)
    private readonly options: { applyDefault: boolean },
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<LimitedRequest>();
    if (req.method === 'OPTIONS') return next.handle(); // a CORS preflight costs nothing (FR-030)
    const entries = this.entriesFor(context, req);
    if (!entries.length) return next.handle();
    const res = http.getResponse<Response>();

    return from(this.admit(entries, req, res)).pipe(
      mergeMap((admission) => this.run(admission, next, res)),
    );
  }

  private entriesFor(
    context: ExecutionContext,
    req: LimitedRequest,
  ): RateLimitRouteOptions[] {
    const targets = [context.getHandler(), context.getClass()];
    const explicit = this.reflector.getAllAndOverride<
      RateLimitRouteOptions[] | undefined
    >(RATE_LIMIT_METADATA, targets);
    if (explicit?.length) return explicit;
    if (this.reflector.getAllAndOverride(RATE_LIMIT_EXEMPT_METADATA, targets))
      return [];
    return this.options.applyDefault ? [defaultEntryFor(req.method)] : [];
  }

  /** Decides every policy in declaration order; one denial returns what the others took and refuses the request. */
  private async admit(
    entries: RateLimitRouteOptions[],
    req: LimitedRequest,
    res: Response,
  ): Promise<Admission> {
    const evaluated: Evaluated[] = [];
    for (const entry of entries) {
      const policy = this.registry.get(entry.policy);
      try {
        evaluated.push(await this.evaluate(entry, policy, req));
      } catch (error) {
        // Helper faults (extractor, cost resolver) follow the fail mode, never a raw 500 (FR-023).
        this.logger.warn(
          `rate limit helper failed for a route (${policy.failMode}): ${(error as Error)?.name}`,
        );
        this.metrics.decisions.add(1, {
          policy: entry.policy,
          allowed: String(policy.failMode === 'open'),
          source: 'fallback',
          reason: 'helper-error',
        });
        if (policy.failMode === 'closed')
          evaluated.push({
            entry,
            policy,
            subject: '',
            cost: 1,
            decision: {
              allowed: false,
              policy: entry.policy,
              limit: policy.limit,
              remaining: 0,
              retryAfterMs: 1_000,
              resetMs: 1_000,
              source: 'fallback',
              reason: 'store-unavailable',
            },
          });
      }
    }

    const denied = evaluated.filter((e) => !e.decision.allowed);
    // On a refusal the allowed policies get their units back below, so the headers report the budget after the refund.
    const headers = headersFor(
      this.headerItems(evaluated, /* refunded */ denied.length > 0),
    );
    if (denied.length === 0) {
      for (const [name, value] of Object.entries(headers))
        res.setHeader(name, value);
      return { taken: evaluated.filter((e) => e.decision.allowed) };
    }

    const requestId = String(
      res.getHeader('x-request-id') ?? req.headers['x-request-id'] ?? '',
    );
    for (const d of denied)
      this.denialLog.denied(d.entry.policy, d.decision, requestId || undefined);

    // A refused request must not cost budget: give back what the allowed policies took.
    await Promise.all(
      evaluated.filter((e) => e.decision.allowed).map((e) => this.giveBack(e)),
    );
    throw this.denialFor(denied, headers);
  }

  private async evaluate(
    entry: RateLimitRouteOptions,
    policy: RateLimitPolicy,
    req: LimitedRequest,
  ): Promise<Evaluated> {
    const { subject, fellBack } = resolveSubject(
      policy.key,
      req,
      entry.subject as never,
    );
    if (fellBack) this.metrics.subjectFallback.add(1, { policy: entry.policy });
    if (policy.algorithm === 'concurrency') {
      const result = await this.limiter.acquire(entry.policy, subject);
      return {
        entry,
        policy,
        subject,
        cost: 1,
        decision: result.decision,
        release: result.acquired ? result.release : undefined,
      };
    }
    const cost = entry.cost ? normalizeHttpCost(entry.cost(req)) : 1;
    const decision = await this.limiter.check(entry.policy, subject, cost);
    return { entry, policy, subject, cost, decision };
  }

  /** Items of the RateLimit headers: decisions the store (or a lease) made; never fallback or outage answers. */
  private headerItems(evaluated: Evaluated[], refunded: boolean): HeaderItem[] {
    return evaluated
      .filter(
        (e) =>
          e.policy.algorithm !== 'concurrency' &&
          e.decision.source !== 'fallback' &&
          e.decision.reason !== 'store-unavailable' &&
          e.decision.reason !== 'cost-exceeds-limit',
      )
      .map((e) => ({
        name: e.entry.policy,
        limit: e.policy.limit,
        windowMs: e.policy.windowMs,
        remaining:
          refunded && e.decision.allowed
            ? Math.min(e.policy.limit, e.decision.remaining + e.cost)
            : e.decision.remaining,
        resetMs: e.decision.allowed
          ? e.decision.resetMs
          : (e.decision.retryAfterMs ?? 0),
      }));
  }

  private denialFor(denied: Evaluated[], headers: Record<string, string>) {
    const noStore = { ...headers, 'Cache-Control': 'no-store' };
    if (denied.some((d) => d.decision.reason === 'cost-exceeds-limit'))
      return new Domain_RateLimitCostExceededError(headers);
    const limited = denied.filter(
      (d) => d.decision.reason !== 'store-unavailable',
    );
    if (limited.length === 0)
      return new Domain_RateLimiterUnavailableError({
        ...noStore,
        'Retry-After': '1',
      });
    const waitMs = Math.max(
      ...limited.map((d) => d.decision.retryAfterMs ?? 0),
    );
    return new Domain_RateLimitedError(
      Number(formatRetryAfter(waitMs)),
      noStore,
    );
  }

  private async giveBack(e: Evaluated): Promise<void> {
    if (e.release) await e.release();
    else if (e.policy.algorithm !== 'concurrency')
      await this.limiter.refund(e.entry.policy, e.subject, e.cost);
  }

  private run(
    admission: Admission,
    next: CallHandler,
    res: Response,
  ): Observable<unknown> {
    let settled = false;
    const settle = async (status: number | null): Promise<void> => {
      if (settled) return;
      settled = true;
      try {
        await Promise.all(
          admission.taken.map((t) => this.settleOne(t, status)),
        );
      } catch (error) {
        this.logger.warn(`rate limit settle failed: ${(error as Error)?.name}`);
      }
    };

    // The client went away before the answer was written: Nest lets the handler finish, but nothing counts and leases
    // are freed now rather than when the handler eventually ends (FR-033).
    res.once('close', () => {
      if (!res.writableFinished) void settle(null);
    });

    return next.handle().pipe(
      // Awaited before the response goes out, so the next request sees the settled state.
      mergeMap(async (value) => {
        await settle(res.statusCode);
        return value;
      }),
      catchError((error) =>
        from(settle(statusOf(error))).pipe(
          mergeMap(() => throwError(() => error)),
        ),
      ),
      // A client abort ends the stream before either of the above: nothing counts, leases are freed.
      finalize(() => void settle(null)),
    );
  }

  /** Outcome handling: free leases; for failures-only policies keep, clear or return the reserved slot (FR-041). */
  private async settleOne(t: Evaluated, status: number | null): Promise<void> {
    if (t.release) {
      await t.release();
      return;
    }
    if (t.policy.count !== 'failures-only') return;
    const failureStatuses =
      t.entry.failureStatuses ??
      t.policy.failureStatuses ??
      DEFAULT_FAILURE_STATUSES;
    if (status !== null && failureStatuses.includes(status)) return; // the failed attempt keeps its slot
    if (
      status !== null &&
      status >= 200 &&
      status < 300 &&
      t.policy.resetOnSuccess
    ) {
      await this.limiter.reset(t.entry.policy, t.subject);
      return;
    }
    await this.limiter.refund(t.entry.policy, t.subject, t.cost);
  }
}
