import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { installCrashHandlers, installGracefulShutdown } from '@app/infrastructure/lifecycle/graceful-shutdown';

/**
 * Shared HTTP bootstrap for every Nest HTTP app, so security headers, CORS,
 * validation and shutdown behave identically across `core`, `sse-gateway`,
 * `public-api`, `bff`, ...
 */
export function configureHttpApp(app: INestApplication, options: { useStructuredLogger?: boolean; /** false = routes at the root (public API: /v1/...). */ globalPrefix?: string | false } = {}): void {
  const config = app.get(ApiConfigService);

  if (options.useStructuredLogger !== false) {
    app.useLogger(app.get(Logger));
  }

  // JSON API: no inline content is ever rendered, so the CSP can be maximally strict.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // CORS is not a security boundary (lesson 05/01 §4) but an explicit allowlist
  // stops arbitrary sites reading credentialed responses. Unset = legacy reflect-origin for local dev.
  const allowlist = config
    .get('cors_allowed_origins')
    ?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: allowlist?.length ? allowlist : true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    exposedHeaders: ['x-request-id', 'Request-Id', 'Retry-After', 'RateLimit', 'RateLimit-Policy', 'ETag', 'Deprecation', 'Sunset', 'Link', 'Marketplace-Version', 'Idempotent-Replayed'],
  });

  app.getHttpAdapter().getInstance().disable('x-powered-by');

  // Health endpoints live outside /api so the ALB health check path is stable across versions.
  if (options.globalPrefix !== false) {
    app.setGlobalPrefix(options.globalPrefix ?? 'api', {
      exclude: [
        { path: 'livez', method: RequestMethod.GET },
        { path: 'readyz', method: RequestMethod.GET },
        { path: '.well-known/jwks.json', method: RequestMethod.GET },
      ],
    });
  }

  // Custom decorators (@User()) return server-side values (the authenticated user), not client input: never validate them.
  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  installCrashHandlers();
  installGracefulShutdown(app);
}
