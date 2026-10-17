import { All, Controller, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import http from 'node:http';
import https from 'node:https';
import type { Request, Response } from 'express';
import {
  BFF_COOKIES,
  BFF_SESSION_LIMITS,
} from '@marketplace-sandbox/contracts';
import { BffSettings } from '../bff-config';
import { readCookie } from '../credentials/request-credentials';
import { SessionAccess } from '../credentials/session-access';
import { BffProblem } from '../problem';
import { RequestGuards } from '../session/csrf-origin.guard';
import { resolveForwardTarget, type ForwardTarget } from './route-table';

const PREFIX = '/api/bff/f/';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Idle time on the upstream socket; event streams carry heartbeats well inside it. */
const UPSTREAM_IDLE_MS = 65_000;

/**
 * Request headers that may reach core. An allowlist, not a denylist: cookies, `Authorization`, the CSRF token,
 * `Host`, `Origin`, hop-by-hop headers and anything unknown stay behind.
 */
const REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'idempotency-key',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'range',
  'user-agent',
  'x-request-id',
  'traceparent',
  'tracestate',
  'x-anonymous-id',
  'x-api-version',
  'last-event-id',
];

/**
 * The one cookie core owns and the browser must carry: the signed guest cart (S10, `cart=guest:<uuid>.<sig>`). It is
 * forwarded on requests and its `Set-Cookie` is relayed back; every other cookie (the session ones included) stays here.
 */
const CORE_COOKIE = 'cart';

/** Response headers that go back to the browser. `Set-Cookie` (except the guest cart's) and hop-by-hop headers never do. */
const RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'location',
  'retry-after',
  'link',
  'vary',
  'ratelimit',
  'ratelimit-policy',
  'x-request-id',
  'request-id',
  'idempotency-replayed',
  'deprecation',
  'sunset',
  'marketplace-version',
  'www-authenticate',
];

/**
 * W01 C-FWD. The browser reaches every `/api/*` route of core through here (the web rewrites `/api/:path*` to
 * `/api/bff/f/:path*`): the session cookie is turned into a bearer token on the server, everything else is passed on
 * unchanged and streamed in both directions (no aggregate, no body inspection beyond the size rule). Routes that
 * start, rotate or end a credential are not reachable (`route-table.ts`).
 */
@ApiExcludeController()
@Controller('bff/f')
export class ForwardController {
  constructor(
    private readonly settings: BffSettings,
    private readonly sessions: SessionAccess,
    private readonly guards: RequestGuards,
  ) {}

  @All('*path')
  async forward(@Req() req: Request, @Res() res: Response): Promise<void> {
    const url = req.originalUrl ?? req.url;
    const queryAt = url.indexOf('?');
    const pathname = queryAt < 0 ? url : url.slice(0, queryAt);
    const search = queryAt < 0 ? '' : url.slice(queryAt);
    const target = pathname.startsWith(PREFIX)
      ? resolveForwardTarget(pathname.slice(PREFIX.length))
      : ({ kind: 'blocked' } as const);
    if (target.kind === 'blocked') throw new BffProblem('not_found');

    const sessionCookie = readCookie(req, BFF_COOKIES.session);
    if (sessionCookie && !SAFE_METHODS.has(req.method)) {
      this.guards.assertOrigin(req);
      this.guards.assertCsrf(req);
    }
    this.assertBodySize(req, target);

    let accessToken: string | undefined;
    if (sessionCookie) {
      const found = await this.sessions.lookup(sessionCookie, req, res);
      if (found.status === 'active') accessToken = found.accessToken;
    }

    await this.relay(req, res, target, search, accessToken);
  }

  private assertBodySize(req: Request, target: ForwardTarget): void {
    if (target.kind === 'blocked' || target.streamBody) return;
    const declared = Number(req.headers['content-length'] ?? 0);
    const received = (req as Request & { rawBody?: Buffer }).rawBody?.length;
    if (
      declared > BFF_SESSION_LIMITS.bodyBytes ||
      (received ?? 0) > BFF_SESSION_LIMITS.bodyBytes
    )
      throw new BffProblem('payload_too_large');
  }

  private upstreamHeaders(
    req: Request,
    accessToken: string | undefined,
    body: Buffer | undefined,
  ): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    for (const name of REQUEST_HEADERS) {
      const value = req.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    const cart = this.cartCookie(req.headers.cookie);
    if (cart) headers.cookie = cart;
    if (body) headers['content-length'] = body.length;
    const clientIp = (req as Request & { clientIp?: string }).clientIp;
    if (clientIp) headers['x-forwarded-for'] = clientIp;
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    return headers;
  }

  private cartCookie(header: string | undefined): string | undefined {
    return header
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${CORE_COOKIE}=`));
  }

  private relay(
    req: Request,
    res: Response,
    target: Exclude<ForwardTarget, { kind: 'blocked' }>,
    search: string,
    accessToken: string | undefined,
  ): Promise<void> {
    const origin =
      target.kind === 'sse'
        ? this.settings.sseOrigin
        : this.settings.upstreamOrigin;
    const url = new URL(`/api/${target.rest}${search}`, origin);
    if (url.origin !== origin) throw new BffProblem('not_found');

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const hasBody =
      !['GET', 'HEAD'].includes(req.method) &&
      (rawBody !== undefined ||
        req.headers['transfer-encoding'] !== undefined ||
        Number(req.headers['content-length'] ?? 0) > 0);
    const client = url.protocol === 'https:' ? https : http;

    return new Promise<void>((resolve, reject) => {
      const upstream = client.request(
        url,
        {
          method: req.method,
          headers: this.upstreamHeaders(req, accessToken, rawBody),
          timeout: UPSTREAM_IDLE_MS,
        },
        (answer) => {
          res.status(answer.statusCode ?? 502);
          for (const name of RESPONSE_HEADERS) {
            const value = answer.headers[name];
            if (value !== undefined) res.setHeader(name, value);
          }
          const cartSet = answer.headers['set-cookie']?.filter((c) =>
            c.startsWith(`${CORE_COOKIE}=`),
          );
          if (cartSet?.length) res.setHeader('Set-Cookie', cartSet);
          if (accessToken) {
            // An event stream keeps `no-transform`: a compressing hop in front (Next's `compress`) would buffer it in gzip and no frame would arrive.
            const stream = String(answer.headers['content-type'] ?? '').startsWith('text/event-stream');
            res.setHeader('Cache-Control', stream ? 'no-store, no-transform' : 'no-store');
          }
          answer.on('error', () => res.destroy());
          answer.pipe(res);
          res.once('close', () => {
            answer.destroy();
            resolve();
          });
        },
      );
      upstream.on('timeout', () =>
        upstream.destroy(new Error('upstream idle timeout')),
      );
      upstream.on('error', (error) => {
        if (res.headersSent) {
          res.destroy();
          resolve();
        } else reject(new BffProblem('bad_gateway', { cause: error }));
      });
      res.once('close', () => {
        if (!res.writableFinished) upstream.destroy();
      });

      if (!hasBody) upstream.end();
      else if (rawBody) upstream.end(rawBody);
      else req.pipe(upstream);
    });
  }
}
