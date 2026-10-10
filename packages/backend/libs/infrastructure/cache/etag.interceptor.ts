import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { map, Observable } from 'rxjs';
import { Clock, CLOCK, SystemClock } from '@app/common/core/clock';
import { CacheLog } from './cache-log';
import { cacheMetrics } from './cache-metrics';
import { isEntityTag, matchesIfNoneMatch } from './etag-match';

const MAX_ETAG_BYTES = 256;
const INVALID_LOG_INTERVAL_MS = 60_000;
/** Marks a body with a caller-supplied entity tag; not enumerable, so it never reaches the JSON. */
const ETAG_MARK = Symbol('cache.etag');
/** Headers that describe the dropped body: removed from a `304`. Every other header the handler set stays. */
const BODY_HEADERS = ['Content-Length', 'Content-Type', 'Content-Encoding'];

/** Tags `body` with a strong or weak entity tag chosen by the caller, e.g. `"story-1-v2-en"` (emitted verbatim). */
export function withEtag<T>(body: T, etag: string): T {
  if (typeof body === 'object' && body !== null)
    Object.defineProperty(body, ETAG_MARK, {
      value: etag,
      enumerable: false,
      configurable: true,
    });
  return body;
}

/** A plain JSON-able object: not a stream, buffer or array. */
function isObjectBody(body: unknown): body is Record<string | symbol, unknown> {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    !Buffer.isBuffer(body) &&
    !(body instanceof StreamableFile) &&
    typeof (body as { pipe?: unknown }).pipe !== 'function'
  );
}

const usableTag = (etag: string): boolean =>
  Buffer.byteLength(etag, 'utf8') <= MAX_ETAG_BYTES && isEntityTag(etag);

/**
 * Validator and `304` for GET/HEAD (P0410, RFC 9110): a body `{id: string, version: non-negative integer}` gets
 * the weak tag `W/"<id>-v<version>"`; a body marked with `withEtag` gets its tag verbatim; anything else passes
 * through untouched. `If-None-Match` is evaluated as a list with weak comparison (and `*`); a match answers `304`
 * with an empty body and every header the handler set except the body headers. Errors and unsafe methods are never
 * touched, and the handler's own `Cache-Control` is never overwritten. It runs after the handler's own guards
 * and loading, so a `304` is only possible for a caller who was allowed to read the resource.
 */
@Injectable()
export class VersionEtagInterceptor implements NestInterceptor {
  private readonly log: CacheLog;

  constructor(@Optional() @Inject(CLOCK) clock?: Clock) {
    this.log = new CacheLog(clock ?? new SystemClock());
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next.handle();

    // Express answers 304 on its own for `If-None-Match: *` (and by header comparison) when it sends a response.
    // On a route under this interceptor only the interceptor decides: no validator, no 304.
    Object.defineProperty(req, 'fresh', { value: false, configurable: true });

    return next.handle().pipe(
      map((body: unknown) => {
        if (res.statusCode < 200 || res.statusCode > 299) return body;
        if (!isObjectBody(body) || res.getHeader('ETag') !== undefined)
          return body;

        const etag = this.validatorOf(body);
        if (!etag) return body;

        res.setHeader('ETag', etag);
        if (!matchesIfNoneMatch(req.headers['if-none-match'], etag))
          return body;
        res.status(304);
        for (const header of BODY_HEADERS) res.removeHeader(header);
        return undefined;
      }),
    );
  }

  private validatorOf(
    body: Record<string | symbol, unknown>,
  ): string | undefined {
    const supplied = body[ETAG_MARK];
    if (supplied !== undefined) {
      if (typeof supplied === 'string' && usableTag(supplied)) return supplied;
      return this.rejected();
    }
    const { id, version } = body;
    if (typeof id !== 'string' || typeof version !== 'number') return undefined;
    if (!Number.isSafeInteger(version) || version < 0) return undefined;
    const derived = `W/"${id}-v${version}"`;
    return usableTag(derived) ? derived : this.rejected();
  }

  private rejected(): undefined {
    cacheMetrics().etagInvalid.add(1);
    this.log.warnLimited(
      'http',
      'etag-invalid',
      INVALID_LOG_INTERVAL_MS,
      'entity tag is not a valid quoted tag of at most 256 bytes and was not emitted',
    );
    return undefined;
  }
}
