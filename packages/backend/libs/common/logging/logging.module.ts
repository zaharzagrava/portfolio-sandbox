import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import pino from 'pino';
import { hostname } from 'node:os';
import { ClsServiceManager } from 'nestjs-cls';
import { trace } from '@opentelemetry/api';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { Environment } from '@app/common/types';
import { isExemptPath } from './exempt-paths';
import { AppClsStore } from '@app/common/request-context/types';
import { redact } from './redaction';

/** The matched route's template (`/orders/:id`); unmatched paths collapse to one value instead of echoing the URL. */
const routeTemplate = (req: IncomingMessage): string => {
  const path = (req as IncomingMessage & { route?: { path?: unknown } }).route
    ?.path;
  return typeof path === 'string' && !path.includes('*') ? path : 'unmatched';
};

/**
 * JSON logs to stdout (collected by the OTel collector / CloudWatch agent, SD-33).
 * Every line carries requestId/userId/shopId from CLS and traceId/spanId from
 * OTel, so logs ↔ traces are one click apart. Secrets and PII are redacted at
 * the source - not in the log pipeline, where it's too late.
 */
@Global()
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ApiConfigModule],
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) => {
        const env = config.get('node_env');
        // LOG_FILE (local full-stack runs): JSON to stdout AND a file Alloy tails into Loki (SD-33). Pretty printing is off then.
        const file = process.env.LOG_FILE;
        const options = {
          // info by default everywhere; debug only when asked for (LOG_LEVEL), never implicitly outside production.
          level: config.get('log_level') ?? 'info',
          base: {
            service: process.env.OTEL_SERVICE_NAME ?? 'marketplace',
            pid: process.pid,
            hostname: hostname(),
          },
          transport:
            env === Environment.local && !file
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          // "level":"info" instead of 30: Loki/Alloy can use it as a (low-cardinality) label directly (SD-33).
          formatters: {
            level: (label: string) => ({ level: label }),
            // Key-name redaction at any depth for everything a caller logs (S54 FR-079); the pino paths below cover req/res headers.
            log: (object: Record<string, unknown>) =>
              redact(object) as Record<string, unknown>,
          },
          // One access line per request: the route template, never the URL with its query string, and no body.
          serializers: {
            req: (req: { id?: unknown; method?: string }) => ({
              id: req.id,
              method: req.method,
            }),
            res: (res: { statusCode?: number }) => ({
              statusCode: res.statusCode,
            }),
          },
          customAttributeKeys: { responseTime: 'durationMs' },
          // pino-http serializes `req` when the request starts, before routing: the route template is only known at the end.
          customSuccessObject: (
            req: IncomingMessage,
            _res: ServerResponse,
            value: object,
          ) => ({ ...value, route: routeTemplate(req) }),
          customErrorObject: (
            req: IncomingMessage,
            _res: ServerResponse,
            _error: Error,
            value: object,
          ) => ({ ...value, route: routeTemplate(req) }),
          autoLogging: {
            ignore: (req: IncomingMessage) => isExemptPath(req.url ?? ''),
          },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'res.headers["set-cookie"]',
              '*.password',
              '*.passwordHash',
              '*.token',
              '*.refreshToken',
              '*.cardNumber',
              '*.iban',
            ],
            censor: '[REDACTED]',
          },
          mixin() {
            const cls = ClsServiceManager.getClsService<AppClsStore>();
            const span = trace.getActiveSpan()?.spanContext();
            return {
              ...(cls?.isActive() && {
                requestId: cls.get('requestId'),
                userId: cls.get('userId'),
                shopId: cls.get('shopId'),
              }),
              ...(span && { traceId: span.traceId, spanId: span.spanId }),
            };
          },
        };
        return {
          pinoHttp: file
            ? [
                options,
                pino.multistream([
                  { stream: process.stdout },
                  {
                    stream: pino.destination({
                      dest: file,
                      mkdir: true,
                      sync: false,
                    }),
                  },
                ]),
              ]
            : options,
        };
      },
    }),
  ],
})
export class LoggingModule {}
