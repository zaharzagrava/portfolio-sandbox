import { BadRequestException, CallHandler, ConflictException, ExecutionContext, HttpException, Injectable, NestInterceptor, UnprocessableEntityException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { Observable, from, of, switchMap, tap, catchError, throwError } from 'rxjs';
import { RedisService } from '@app/infrastructure/redis/redis.service';

const TTL_SEC = 24 * 3600;
const LOCK_TTL_SEC = 60;
const KEY = /^[\w-]{8,128}$/;

interface Stored {
  state: 'in-flight' | 'done';
  fingerprint: string;
  status?: number;
  body?: unknown;
}

/**
 * Idempotency-Key for unsafe requests (04/03 §1, Stripe semantics):
 *  - first request with a key claims it (SET NX, 60 s in-flight lock), runs,
 *    and stores status + body for 24 h;
 *  - a retry with the same key and same payload replays the stored response
 *    (`Idempotent-Replayed: true`) - no second side effect;
 *  - same key, different payload → 422 (client bug); while the first is
 *    still running → 409 (retry later);
 *  - 5xx responses release the key (the operation may be retried for real).
 * Scoped per caller (`scope(req)`), so keys never collide across tenants.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request & { apiKey?: { id: string }; user?: { id: string } }>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const header = req.headers['idempotency-key'];
    if (req.method === 'GET' || req.method === 'HEAD' || header === undefined) return next.handle();
    if (typeof header !== 'string' || !KEY.test(header)) throw new BadRequestException('Idempotency-Key must be 8-128 chars [A-Za-z0-9_-]');

    const scope = req.apiKey?.id ?? req.user?.id ?? 'anon';
    const key = `idem:{${scope}}:${header}`;
    const fingerprint = createHash('sha256').update(`${req.method} ${req.path} ${JSON.stringify(req.body ?? null)}`).digest('base64url');

    return from(this.claim(key, fingerprint)).pipe(
      switchMap((existing) => {
        if (!existing) {
          return next.handle().pipe(
            tap((body) => void this.redis.client.set(key, JSON.stringify({ state: 'done', fingerprint, status: res.statusCode, body } satisfies Stored), 'EX', TTL_SEC)),
            catchError((error: { status?: number }) => {
              const status = error.status ?? 500;
              const write =
                status >= 500
                  ? this.redis.client.del(key)
                  : this.redis.client.set(key, JSON.stringify({ state: 'done', fingerprint, status, body: (error as { getResponse?: () => unknown }).getResponse?.() } satisfies Stored), 'EX', TTL_SEC);
              return from(write).pipe(switchMap(() => throwError(() => error)));
            }),
          );
        }
        if (existing.fingerprint !== fingerprint) throw new UnprocessableEntityException('Idempotency-Key reused with a different request');
        if (existing.state === 'in-flight') throw new ConflictException('A request with this Idempotency-Key is still in progress');
        res.status(existing.status ?? 200);
        res.setHeader('Idempotent-Replayed', 'true');
        if ((existing.status ?? 200) >= 400) throw new HttpException(existing.body ?? 'Error', existing.status!);
        return of(existing.body);
      }),
    );
  }

  /** null = we own it now; otherwise the stored record. */
  private async claim(key: string, fingerprint: string): Promise<Stored | null> {
    const claimed = await this.redis.client.set(key, JSON.stringify({ state: 'in-flight', fingerprint } satisfies Stored), 'EX', LOCK_TTL_SEC, 'NX');
    if (claimed) return null;
    const raw = await this.redis.client.get(key);
    return raw ? (JSON.parse(raw) as Stored) : null;
  }
}
