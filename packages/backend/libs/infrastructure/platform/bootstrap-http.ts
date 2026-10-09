import { INestApplication, RequestMethod } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { httpProductionRule } from '@app/common/config/config-rules';
import { createValidationPipe } from '@app/common/exceptions-filter/validation-pipe';
import { LoadSheddingGate } from '@app/common/load-shedding/load-shedding.middleware';
import {
  matchMetadataRoute,
  MetadataRoute,
  scanMetadataRoutes,
} from '@app/common/routing/route-metadata';
import { RouteTable } from '@app/common/routing/route-table';
import { Environment } from '@app/common/types';
import {
  applyServerTimeouts,
  installCrashHandlers,
  installGracefulShutdown,
  resolveShutdownConfigFor,
} from '@app/infrastructure/lifecycle/graceful-shutdown';
import type { ShutdownConfig } from '@app/infrastructure/lifecycle/shutdown-config';
import { parseTrustedProxies, resolveClientIp } from './client-ip';
import {
  SECURITY_POLICY,
  SecurityPolicyName,
} from './security-policy.decorator';

/** Mounts the load-shedding gate as the first middleware of the app. */
export function mountLoadShedding(
  app: INestApplication,
  options: { globalPrefix?: string | false } = {},
): void {
  app.use(app.get(LoadSheddingGate).middleware(options));
}

const BODY_LIMIT = '1mb';
/** Responses under this size are not worth a gzip frame. */
const COMPRESSION_THRESHOLD = 1024;
const CORS_MAX_AGE_SECONDS = 600;
/** Nothing is ever rendered inline by this API, so nothing may load or frame. */
const CSP = "default-src 'none'; frame-ancestors 'none'";

const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Accept',
  'Accept-Language',
  'Idempotency-Key',
  'X-Request-Id',
  'If-Match',
  'If-None-Match',
  'Traceparent',
  'Tracestate',
  'X-Api-Version',
];
const CORS_EXPOSED_HEADERS = [
  'X-Request-Id',
  'Request-Id',
  'Retry-After',
  'RateLimit',
  'RateLimit-Policy',
  'ETag',
  'Deprecation',
  'Sunset',
  'Link',
  'Marketplace-Version',
  'Idempotency-Replayed',
];

export interface HttpAppOptions {
  useStructuredLogger?: boolean;
  /** false = routes at the root (public API: /v1/...). */
  globalPrefix?: string | false;
  /** false = do not install process signal/crash handlers (e2e specs running inside the jest process). */
  processHandlers?: boolean;
  /** Overrides for the shutdown and server timings on top of configuration. */
  shutdown?: Partial<ShutdownConfig>;
}

type RawBodyRequest = Request & { rawBody?: Buffer; clientIp?: string };

/**
 * Shared HTTP bootstrap for every Nest HTTP app, so security headers, CORS, client address, body limits, validation
 * and shutdown behave identically across `core`, `sse-gateway`, `public-api`, `bff`, ...
 *
 * The order is fixed here, once (S54 FR-076): load shedding → security headers → CORS → client address →
 * compression → body parsing (1 MiB, exact bytes in `rawBody`) → [request context and logging, mounted by their
 * modules] → guards → interceptors (rate limit, idempotency) → validation pipe → handler → exception filter.
 */
export function configureHttpApp(
  app: INestApplication,
  options: HttpAppOptions = {},
): void {
  const config = app.get(ApiConfigService);
  const production = config.get('node_env') === Environment.production;
  const globalPrefix =
    options.globalPrefix === undefined ? 'api' : options.globalPrefix;
  const prefix = globalPrefix ? `/${globalPrefix.replace(/^\/|\/$/g, '')}` : '';

  // Fail startup, naming the key, before anything listens (S54 AS-135, AS-137).
  const problems = httpProductionRule({
    get: (key) => config.get(key as never),
    production,
  });
  if (problems.length > 0)
    throw new Error(`Config validation error: ${problems.join('; ')}`);

  if (options.useStructuredLogger !== false) {
    app.useLogger(app.get(Logger));
  }

  // 1. Load shedding: a shed request costs one header write - no CORS work, no body read, no authentication.
  mountLoadShedding(app, { globalPrefix });

  // Route groups that opt into a named policy (`@SecurityPolicy('public-embed')`), found once on first use.
  let policyRoutes: MetadataRoute<SecurityPolicyName>[] | undefined;
  const policyOf = (req: Request): SecurityPolicyName | undefined => {
    policyRoutes ??= scanMetadataRoutes<SecurityPolicyName>(
      app.get(DiscoveryService, { strict: false }),
      SECURITY_POLICY,
    );
    return matchMetadataRoute(policyRoutes, req.method, req.path, prefix);
  };

  // 2. Security headers. JSON API: no inline content is ever rendered, so the CSP can be maximally strict.
  const headers = (corp: 'same-site' | 'cross-origin') =>
    helmet({
      contentSecurityPolicy: false, // set below as one literal string
      crossOriginResourcePolicy: { policy: corp },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: production
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
    });
  const strictHeaders = headers('same-site');
  const embedHeaders = headers('cross-origin');
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', CSP);
    (policyOf(req) === 'public-embed' ? embedHeaders : strictHeaders)(
      req,
      res,
      next,
    );
  });

  // 3. CORS: an explicit allowlist (not a security boundary, but it stops arbitrary sites reading credentialed
  // responses). Unset outside production = reflect the origin for local development.
  const allowlist = (config.get('cors_allowed_origins') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const strictCors: CorsOptions = {
    origin: allowlist.length > 0 ? allowlist : !production,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: CORS_MAX_AGE_SECONDS,
  };
  const embedCors: CorsOptions = {
    origin: '*',
    methods: 'GET,HEAD,OPTIONS',
    credentials: false,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: CORS_MAX_AGE_SECONDS,
  };
  app.enableCors(
    (
      req: Request,
      callback: (error: Error | null, options?: CorsOptions) => void,
    ) =>
      callback(null, policyOf(req) === 'public-embed' ? embedCors : strictCors),
  );

  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Validators come from the cache toolkit's VersionEtagInterceptor / withEtag only (S52 FR-036, FR-039): Express'
  // automatic weak ETag would put a body hash on errors and on every write response, and answer 304 on its own.
  app.getHttpAdapter().getInstance().set('etag', false);

  // 4. Client address: the TCP peer, or the first untrusted `X-Forwarded-For` hop behind a trusted proxy (FR-072).
  const trustedProxies = parseTrustedProxies(
    config.get('trusted_proxies') || 'none',
  );
  app.use((req: RawBodyRequest, _res: Response, next: NextFunction) => {
    req.clientIp = resolveClientIp({
      peer: req.socket.remoteAddress ?? '',
      forwardedFor: req.headers['x-forwarded-for'],
      trustedProxies,
    });
    next();
  });

  // 5. Compression: JSON over 1 KiB; never event streams (the `no-transform` opt-out is honoured by the library).
  const skipEventStreams: RequestHandler = compression({
    threshold: COMPRESSION_THRESHOLD,
    filter: (req, res) =>
      !/text\/event-stream/i.test(
        String(res.getHeader('Content-Type') ?? ''),
      ) && compression.filter(req, res),
  });
  app.use(skipEventStreams);

  // 6. Body parsing: 1 MiB, and the exact received bytes stay available to signature-verifying handlers.
  const keepRawBody = (req: Request, _res: Response, buffer: Buffer) => {
    if (Buffer.isBuffer(buffer)) (req as RawBodyRequest).rawBody = buffer;
  };
  const expressApp = app as NestExpressApplication;
  expressApp.useBodyParser('json', { limit: BODY_LIMIT, verify: keepRawBody });
  expressApp.useBodyParser('urlencoded', {
    limit: BODY_LIMIT,
    extended: true,
    verify: keepRawBody,
  });

  // Health endpoints live outside /api so the ALB health check path is stable across versions.
  if (globalPrefix !== false) {
    app.setGlobalPrefix(globalPrefix, {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/startup', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
        { path: '.well-known/jwks.json', method: RequestMethod.GET },
      ],
    });
  }

  // A known path called with the wrong method answers 405 + Allow instead of 404 (AS-07): the filter needs the prefix.
  app.get(RouteTable, { strict: false })?.setPrefix(prefix);

  // Unknown properties are rejected and types transformed (FR-075). Custom decorators (@User()) return server-side
  // values (the authenticated user), not client input: never validate them.
  app.useGlobalPipes(createValidationPipe());

  if (options.processHandlers === false) {
    // Tests: no process-wide signal handlers, but the server timeouts and their validation still apply.
    applyServerTimeouts(
      app.getHttpServer(),
      resolveShutdownConfigFor(app, options.shutdown),
    );
  } else {
    installCrashHandlers();
    installGracefulShutdown(app, { config: options.shutdown });
  }
}
