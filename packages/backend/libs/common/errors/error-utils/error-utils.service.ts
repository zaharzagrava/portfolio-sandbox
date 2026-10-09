import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Environment } from '@app/common/types';
import { AppError, ErrorArea, InternalServerError } from '../error.types';
import { PlatformCodes } from '../platform-codes';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { ERROR_TRACKER, SentryErrorTracker } from './error-tracker';
import type { ErrorTracker } from './error-tracker';

const RETRY_AFTER_DB_SECONDS = 1;

/** Postgres SQLSTATE → platform problem (S54 G-03/G-04): no table, column or value ever reaches the client. */
const PG_STATE_TO_PROBLEM: Record<
  string,
  {
    code: string;
    status: HttpStatus;
    title: string;
    detail: string;
    retry?: boolean;
  }
> = {
  '23505': {
    code: PlatformCodes.conflict,
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The request conflicts with the current state of the resource.',
  },
  '57014': {
    code: PlatformCodes.database_timeout,
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'The request took too long. Please retry.',
    retry: true,
  },
  '55P03': {
    code: PlatformCodes.db_lock_timeout,
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'The resource is busy. Please retry.',
    retry: true,
  },
  '40001': {
    code: PlatformCodes.transaction_conflict,
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'The request conflicted with a concurrent update. Please retry.',
    retry: true,
  },
  '40P01': {
    code: PlatformCodes.transaction_conflict,
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'The request conflicted with a concurrent update. Please retry.',
    retry: true,
  },
};

/** Walks the `cause` / `original` / `parent` chain for a Postgres SQLSTATE. */
export function findPgState(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: any = error;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur.code === 'string' && /^[0-9A-Z]{5}$/.test(cur.code))
      return cur.code;
    cur = cur.original ?? cur.parent ?? cur.cause;
  }
  return undefined;
}

const HTTP_STATUS_TO_CODE: Record<number, { code: string; title: string }> = {
  400: { code: PlatformCodes.validation_failed, title: 'Bad Request' },
  401: { code: PlatformCodes.unauthenticated, title: 'Unauthorized' },
  403: { code: PlatformCodes.forbidden, title: 'Forbidden' },
  404: { code: PlatformCodes.not_found, title: 'Not Found' },
  405: { code: PlatformCodes.method_not_allowed, title: 'Method Not Allowed' },
  409: { code: PlatformCodes.conflict, title: 'Conflict' },
  413: { code: PlatformCodes.payload_too_large, title: 'Payload Too Large' },
  415: {
    code: PlatformCodes.unsupported_media_type,
    title: 'Unsupported Media Type',
  },
};

const BODY_PARSER_ERRORS: Record<string, { status: number; code: string }> = {
  'entity.parse.failed': { status: 400, code: PlatformCodes.malformed_body },
  'entity.too.large': { status: 413, code: PlatformCodes.payload_too_large },
  'encoding.unsupported': {
    status: 415,
    code: PlatformCodes.unsupported_media_type,
  },
  'charset.unsupported': {
    status: 415,
    code: PlatformCodes.unsupported_media_type,
  },
};

@Injectable()
export class ErrorUtilsService {
  private readonly l = new Logger(ErrorUtilsService.name);
  private readonly tracker: ErrorTracker;

  constructor(
    private readonly configService: ApiConfigService,
    @Optional() @Inject(ERROR_TRACKER) tracker?: ErrorTracker,
  ) {
    this.tracker = tracker ?? new SentryErrorTracker();
  }

  /** Sends one server-side failure to the tracker (a bound spy also receives it under NODE_ENV=test). */
  public track(error: unknown, extra?: Record<string, unknown>): void {
    try {
      this.tracker.capture(error, extra);
    } catch (e) {
      this.l.warn(`error tracker failed: ${(e as Error).message}`);
    }
  }

  public captureSentryException(error: any): Error {
    if (this.configService.get('node_env') === Environment.test) return error;
    this.track(error);
    return error;
  }

  public normalizeError(exception: unknown): AppError {
    if (exception instanceof AppError) return exception;
    // Errors that know how they should be answered (e.g. the resilient client's HttpClientError → 502/503/504).
    if (
      typeof (exception as { toAppError?: unknown } | null)?.toAppError ===
      'function'
    )
      return (exception as { toAppError(): AppError }).toAppError();

    const errorObj =
      exception instanceof Error ? exception : new Error(String(exception));

    // Postgres errors, wrapped (Sequelize) or raw.
    const pgState = findPgState(exception);
    const pg = pgState ? PG_STATE_TO_PROBLEM[pgState] : undefined;
    if (pg) {
      return new AppError({
        code: pg.code,
        status: pg.status,
        title: pg.title,
        detail: pg.detail,
        area: pg.retry ? ErrorArea.TRANSIENT : ErrorArea.DOMAIN,
        retryAfterSeconds: pg.retry ? RETRY_AFTER_DB_SECONDS : undefined,
        causes: [errorObj],
      });
    }
    if (
      /SequelizeConnectionAcquireTimeoutError|ConnectionAcquireTimeout/.test(
        errorObj.name,
      )
    ) {
      return new AppError({
        code: PlatformCodes.database_unavailable,
        status: HttpStatus.SERVICE_UNAVAILABLE,
        title: 'Service Unavailable',
        detail: 'The service is temporarily unavailable. Please retry.',
        area: ErrorArea.TRANSIENT,
        retryAfterSeconds: RETRY_AFTER_DB_SECONDS,
        causes: [errorObj],
      });
    }

    // body-parser (http-errors) failures arrive as plain errors with `type`.
    const bodyParser =
      BODY_PARSER_ERRORS[(exception as { type?: string })?.type ?? ''] ??
      BODY_PARSER_ERRORS[
        (exception as { cause?: { type?: string } })?.cause?.type ?? ''
      ] ??
      // Nest rewraps the parser's SyntaxError into a plain BadRequestException; recognise it by its message.
      (exception instanceof HttpException &&
      exception.getStatus() === 400 &&
      /JSON|Unexpected (token|end)/i.test(exception.message)
        ? BODY_PARSER_ERRORS['entity.parse.failed']
        : exception instanceof HttpException &&
            /unsupported (charset|content encoding)/i.test(exception.message)
          ? BODY_PARSER_ERRORS['charset.unsupported']
          : undefined);
    if (bodyParser) {
      return new AppError({
        code: bodyParser.code,
        status: bodyParser.status,
        title: HTTP_STATUS_TO_CODE[bodyParser.status]?.title ?? 'Bad Request',
        detail:
          bodyParser.code === PlatformCodes.malformed_body
            ? 'The request body is not valid JSON.'
            : errorObj.message,
        area: ErrorArea.DOMAIN,
        causes: [errorObj],
      });
    }

    // NestJS HttpExceptions (ValidationPipe, guards, Unauthorized/Forbidden, NotFound, MethodNotAllowed ...)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse() as any;
      const mapped = HTTP_STATUS_TO_CODE[status];
      // 401/403 must not explain why access was denied.
      const detail =
        status === 401 || status === 403
          ? `${mapped?.title ?? 'Access denied'}.`
          : typeof response === 'string'
            ? response
            : response?.message || exception.message;
      const headers: Record<string, string> = {};
      const origHeaders = (exception as { headers?: Record<string, string> })
        .headers;
      if (origHeaders) Object.assign(headers, origHeaders);

      return new AppError({
        code:
          typeof response?.code === 'string'
            ? response.code
            : (mapped?.code ??
              (status >= 500 ? PlatformCodes.internal_error : 'http_error')),
        detail: Array.isArray(detail) ? detail.join(', ') : String(detail),
        title: mapped?.title ?? 'HTTP Exception',
        status,
        area: status >= 500 ? ErrorArea.FATAL : ErrorArea.DOMAIN,
        headers,
        causes: [errorObj],
      });
    }

    if (errorObj.name.startsWith('Sequelize')) {
      return new InternalServerError('Database operation failed.', {
        causes: [errorObj],
      });
    }

    return new InternalServerError('An unexpected internal error occurred.', {
      causes: [errorObj],
    });
  }
}
