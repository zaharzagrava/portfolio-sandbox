import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import {
  Observable,
  catchError,
  from,
  map,
  mergeMap,
  of,
  throwError,
} from 'rxjs';
import { CLOCK, Clock } from '@app/common/core/clock';
import { AppError, ErrorArea } from '@app/common/errors/error.types';
import { RequestContext } from '@app/infrastructure/context/request-context.service';
import { idempotencyError } from './idempotency.errors';
import {
  IdempotencyRecord,
  IdempotencyRepository,
  IdempotencyStoreUnavailable,
} from './idempotency.repository';
import { requestFingerprint } from './fingerprint';
import { IDEMPOTENT_METADATA, IdempotentOptions } from './idempotent.metadata';

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;
const DEFAULT_TTL_SECONDS = 24 * 3600;
const LOCK_MS = 60_000;
const MAX_BODY_BYTES = 256 * 1024;
const REPLAYED_HEADER = 'Idempotency-Replayed';
/** Response headers worth replaying; everything else (`Set-Cookie`, `Date`, ...) belongs to the original attempt. */
const REPLAY_HEADERS = ['Content-Type', 'Location', 'ETag'];
const MAX_SCOPE_LENGTH = 160;

type IdempotentRequest = Request & {
  apiKey?: { id: string };
  user?: { id: string };
  clientIp?: string;
};

/**
 * Idempotency for routes declared with `@Idempotent()` (FR-063 to FR-069). It runs as an interceptor, so after
 * authentication and throttling guards and before validation pipes. The claim is one atomic statement in the database
 * (all instances agree); the answer is stored and awaited before the response is released.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly repository: IdempotencyRepository,
    private readonly context: RequestContext,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<IdempotentOptions | undefined>(
      IDEMPOTENT_METADATA,
      ctx.getHandler(),
    );
    const req = ctx.switchToHttp().getRequest<IdempotentRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    if (!options || req.method === 'GET' || req.method === 'HEAD')
      return next.handle();

    const key = this.readKey(req);
    if (key === undefined) {
      if (options.required === false) return next.handle();
      throw idempotencyError('idempotency_key_required');
    }

    const scope = this.scopeOf(req);
    const fingerprint = requestFingerprint({
      method: req.method,
      path: req.path,
      rawQuery: req.originalUrl.includes('?')
        ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1)
        : '',
      body: req.body,
    });
    const ttlMs = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;

    return from(
      this.repository.claim({
        scope,
        key,
        fingerprint,
        now: this.clock.now(),
        ttlMs,
        lockMs: LOCK_MS,
      }),
    ).pipe(
      catchError((error) =>
        throwError(() =>
          error instanceof IdempotencyStoreUnavailable
            ? this.unavailable(error)
            : error,
        ),
      ),
      mergeMap((claim) => {
        if (!claim.claimed)
          return this.replay(claim.existing, fingerprint, res);
        return next.handle().pipe(
          catchError((error) =>
            from(this.settleFailure(scope, key, claim.token, error)).pipe(
              mergeMap(() => throwError(() => error)),
            ),
          ),
          mergeMap((body) =>
            from(this.settleSuccess(scope, key, claim.token, res, body)).pipe(
              map(() => body),
            ),
          ),
        );
      }),
    );
  }

  /** The single valid key, `undefined` when absent; throws `idempotency_key_invalid` for any malformed form. */
  private readKey(req: Request): string | undefined {
    const copies = req.rawHeaders.filter(
      (name, i) => i % 2 === 0 && name.toLowerCase() === 'idempotency-key',
    ).length;
    if (copies === 0) return undefined;
    const value = req.headers['idempotency-key'];
    if (copies > 1 || typeof value !== 'string' || !KEY_FORMAT.test(value))
      throw idempotencyError('idempotency_key_invalid');
    return value;
  }

  private scopeOf(req: IdempotentRequest): string {
    const principal = req.apiKey?.id ?? this.context.userId ?? req.user?.id;
    const scope = principal
      ? `principal:${principal}`
      : `ip:${this.context.snapshot().clientIp ?? req.clientIp ?? req.ip ?? 'unknown'}`;
    return scope.length <= MAX_SCOPE_LENGTH
      ? scope
      : `${scope.slice(0, scope.indexOf(':') + 1)}${createHash('sha256').update(scope).digest('hex')}`;
  }

  private unavailable(cause: IdempotencyStoreUnavailable): AppError {
    this.logger.error(
      `idempotency store unavailable: ${String((cause.cause as Error | undefined)?.message ?? cause.message)}`,
    );
    return idempotencyError('idempotency_unavailable', {
      retryAfterSeconds: 1,
    });
  }

  private replay(
    existing: IdempotencyRecord,
    fingerprint: string,
    res: Response,
  ): Observable<unknown> {
    if (existing.fingerprint.trim() !== fingerprint)
      throw idempotencyError('idempotency_key_reuse');
    if (existing.state === 'in_flight')
      throw idempotencyError('idempotency_in_flight', { retryAfterSeconds: 1 });
    if (!existing.bodyStored)
      throw idempotencyError('idempotency_replay_unavailable');

    res.setHeader(REPLAYED_HEADER, 'true');
    const status = existing.responseStatus ?? 200;
    const stored = existing.responseBody
      ? (JSON.parse(existing.responseBody.toString('utf8')) as unknown)
      : undefined;
    if (status >= 400) {
      const e = stored as {
        code: string;
        status: number;
        title: string;
        detail: string;
        extensions?: Record<string, unknown>;
      };
      throw new AppError({
        code: e.code,
        status: e.status,
        title: e.title,
        detail: e.detail,
        extensions: e.extensions,
        area: ErrorArea.DOMAIN,
        idempotencyFinal: true,
      });
    }
    for (const [name, value] of Object.entries(existing.responseHeaders ?? {}))
      res.setHeader(name, value);
    res.status(status);
    return of(stored);
  }

  private async settleSuccess(
    scope: string,
    key: string,
    token: string,
    res: Response,
    body: unknown,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    for (const name of REPLAY_HEADERS) {
      const value = res.getHeader(name);
      if (value !== undefined) headers[name] = String(value);
    }
    const bytes =
      body === undefined
        ? null
        : Buffer.from(JSON.stringify(body) ?? 'null', 'utf8');
    const tooBig = bytes !== null && bytes.length > MAX_BODY_BYTES;
    await this.store({
      scope,
      key,
      token,
      status: res.statusCode,
      headers: Object.keys(headers).length ? headers : null,
      body: tooBig ? null : bytes,
      bodyStored: !tooBig,
    });
  }

  /** Releases the key so the client may retry, unless the error is declared final: then the answer is stored. */
  private async settleFailure(
    scope: string,
    key: string,
    token: string,
    error: unknown,
  ): Promise<void> {
    try {
      if (error instanceof AppError && error.idempotencyFinal) {
        const body = Buffer.from(
          JSON.stringify({
            code: error.code,
            status: error.status,
            title: error.title,
            detail: error.message,
            extensions: error.extensions,
          }),
          'utf8',
        );
        await this.store({
          scope,
          key,
          token,
          status: error.status,
          headers: null,
          body,
          bodyStored: true,
        });
      } else if (!(await this.repository.release(scope, key, token))) {
        this.logger.warn(
          `idempotency claim for ${scope} was taken over before release`,
        );
      }
    } catch (storeError) {
      this.logger.error(
        `idempotency failure settle failed: ${(storeError as Error).message}`,
      );
    }
  }

  private async store(
    input: Parameters<IdempotencyRepository['complete']>[0],
  ): Promise<void> {
    try {
      if (!(await this.repository.complete(input)))
        this.logger.warn(
          `idempotency claim for ${input.scope} was taken over before completion`,
        );
    } catch (error) {
      // The handler already ran; losing the stored answer only means a retry after the lock expires would run it again.
      this.logger.error(
        `idempotency answer not stored: ${(error as Error).message}`,
      );
    }
  }
}
