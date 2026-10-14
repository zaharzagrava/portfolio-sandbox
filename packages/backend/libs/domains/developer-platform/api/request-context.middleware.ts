import { Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  KeyVerifier,
  type VerifiedKey,
} from '../application/key-verifier.service';
import { routeTemplateOf } from '../domain/public-routes';
import {
  DeprecationEntry,
  DeprecationWindow,
  deprecationHeaders,
  evaluateWindow,
  matchRoute,
} from '../domain/deprecation';
import { costOf } from '../domain/request-record';
import { DEPRECATED_ROUTES, latestVersion } from '../domain/version-registry';
import { RequestRecordSink } from '../infra/request-record.sink';

/** The client's own id for a request, echoed and stored, never used as ours (FR-055). */
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export interface RequestMeta {
  requestId: string;
  clientRequestId?: string;
  startedAtMs: number;
}

export type ApiRequest = Request & {
  apiMeta?: RequestMeta;
  apiKey?: VerifiedKey;
  apiVersion?: string;
};

/** A deprecated route this call reached and where it stands, kept for the version guard (one count per call). */
export interface DeprecatedRouteHit {
  path: string;
  entry: DeprecationEntry;
  window: DeprecationWindow;
}

/** Sets the registry's headers once, in one place (R-07). */
export function setDeprecationHeaders(
  res: Response,
  entry: DeprecationEntry,
): void {
  for (const [name, value] of Object.entries(deprecationHeaders(entry)))
    res.setHeader(name, value);
}

/**
 * First thing every public request meets (FR-055, FR-030, FR-063): a server-generated `Request-Id` (a client's
 * `X-Request-Id` is only echoed as `X-Client-Request-Id`), `Cache-Control: no-store`, and the route registry's headers
 * on a deprecated route, even on a refused call. When the response is finished it hands the sink exactly one record of
 * an authenticated call, built from what was actually sent (FR-054).
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestContextMiddleware.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly sink: RequestRecordSink,
    private readonly verifier: KeyVerifier,
  ) {}

  use(req: ApiRequest, res: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    const requestId = `req_${randomUUID().replace(/-/g, '')}`;
    const client = req.headers['x-request-id'];
    const meta: RequestMeta = {
      requestId,
      startedAtMs: this.clock.now().getTime(),
      ...(typeof client === 'string' && CLIENT_REQUEST_ID.test(client)
        ? { clientRequestId: client }
        : {}),
    };
    req.apiMeta = meta;
    // the platform's request context adopts an inbound `x-request-id`; here the id is always ours, the client's own id
    // only travels as `X-Client-Request-Id`, so the problem document's `requestId` and `Request-Id` are one id (FR-055)
    req.headers['x-request-id'] = requestId;
    res.setHeader('Request-Id', requestId);
    // the problem filter reads this header first, so the document's requestId is ours, never the client's
    res.setHeader('X-Request-Id', requestId);
    if (meta.clientRequestId)
      res.setHeader('X-Client-Request-Id', meta.clientRequestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const hit = matchRoute(
      req.method,
      req.originalUrl ?? req.url,
      DEPRECATED_ROUTES,
    );
    if (hit) {
      const window = evaluateWindow(hit.entry, this.clock.now());
      if (window !== 'live') {
        setDeprecationHeaders(res, hit.entry);
        res.locals.deprecatedRoute = {
          path: hit.path,
          entry: hit.entry,
          window,
        } satisfies DeprecatedRouteHit;
      }
    }

    let errorCode: string | undefined;
    const end = res.end.bind(res) as (...args: unknown[]) => Response;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (
        res.statusCode >= 400 &&
        (typeof chunk === 'string' || Buffer.isBuffer(chunk))
      )
        try {
          const code = (JSON.parse(chunk.toString()) as { code?: unknown })
            .code;
          if (typeof code === 'string') errorCode = code;
        } catch {
          // not a problem document
        }
      return end(chunk, ...rest);
    }) as typeof res.end;

    res.once('finish', () => {
      void this.recordFinished(req, res, meta, started, () => errorCode);
    });
    next();
  }

  /**
   * The key of a call that was refused before its guards ran (a body over the limit, JSON that does not parse) is found
   * from its credential now, so a valid key's refusal is logged too (AS-66); an invalid credential logs nothing (AS-14).
   */
  private async recordFinished(
    req: ApiRequest,
    res: Response,
    meta: RequestMeta,
    started: bigint,
    errorCodeOf: () => string | undefined,
  ): Promise<void> {
    try {
      let key = req.apiKey;
      let route = (req.route as { path?: string } | undefined)?.path;
      if (!key && res.statusCode >= 400) {
        const token = /^Bearer\s+(\S+)$/i.exec(
          req.headers.authorization ?? '',
        )?.[1];
        route =
          routeTemplateOf(req.method, req.originalUrl ?? req.url) ?? undefined;
        if (token && route) {
          const outcome = await this.verifier.check(token);
          if (outcome.ok) key = outcome.key;
        }
      }
      if (!key || !route) return; // unauthenticated calls are counted, never logged (AS-14)
      const errorCode = errorCodeOf();
      const replay = res.getHeader('Idempotent-Replayed') === 'true';
      const { cost, batchOps } = costOf(req.method, route, req.body, replay);
      this.sink.record({
        requestId: meta.requestId,
        ...(meta.clientRequestId
          ? { clientRequestId: meta.clientRequestId }
          : {}),
        shopId: key.liveShopId,
        keyId: key.id,
        livemode: key.livemode,
        version: req.apiVersion ?? latestVersion(),
        method: req.method === 'HEAD' ? 'GET' : req.method,
        route,
        status: res.statusCode,
        durationMs: Math.max(
          0,
          Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        ),
        deprecated: res.locals.deprecated === true,
        ...(errorCode ? { errorCode } : {}),
        ...(batchOps !== undefined ? { batchOps } : {}),
        idempotentReplay: replay,
        cost,
        occurredAt: this.clock.now(),
      });
    } catch (error) {
      this.logger.warn(`request record not built: ${(error as Error).message}`);
    }
  }
}
