import {
  Catch,
  ArgumentsHost,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { trace } from '@opentelemetry/api';
import { v7 as uuidv7 } from 'uuid';
import { AppError, ErrorArea } from '@app/common/errors/error.types';
import { PlatformCodes } from '@app/common/errors/platform-codes';
import { ErrorUtilsService } from '@app/common/errors/error-utils/error-utils.service';
import { RouteTable } from '@app/common/routing/route-table';
import { SENSITIVE_PATH_PARAMS_REQUEST_KEY } from './sensitive-path-params.decorator';
import {
  buildProblemDocument,
  fallbackProblem,
  stripQuery,
} from './problem-document';

/**
 * Single place that turns any thrown value into the RFC 9457 problem document (S54 FR-001..FR-012).
 * The body is built by the pure `buildProblemDocument`; stack and causes go to logs and the tracker only,
 * and `NODE_ENV` never changes what the client sees.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(
    private readonly utilsService: ErrorUtilsService,
    @Optional() private readonly routeTable?: RouteTable,
  ) {
    super();
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const appError =
      this.methodNotAllowed(exception, request) ??
      this.utilsService.normalizeError(exception);
    const requestId = String(
      response.getHeader?.('x-request-id') ??
        request.headers?.['x-request-id'] ??
        uuidv7(),
    );
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    const hasSensitive = (
      request[SENSITIVE_PATH_PARAMS_REQUEST_KEY] as string[] | undefined
    )?.length;
    const instance = stripQuery(
      hasSensitive && request.route?.path
        ? `${request.baseUrl ?? ''}${request.route.path}`
        : (request.originalUrl ?? request.url ?? ''),
    );

    this.logFailure(appError, requestId, instance);
    if (Number(appError.status) >= 500)
      this.utilsService.track(appError, { requestId, path: instance });

    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.recordException(appError);
      activeSpan.setAttributes({
        'error.code': appError.code,
        'http.status_code': appError.status,
      });
      activeSpan.setStatus({ code: 2, message: appError.code });
    }

    // Too late for a clean answer: do not write a second response, drop the connection.
    if (response.headersSent) {
      request.socket?.destroy();
      return;
    }

    const problem = buildProblemDocument(appError, {
      requestId,
      instance,
      traceId,
    });
    try {
      for (const [name, value] of Object.entries(problem.headers))
        response.setHeader(name, value);
      response.setHeader('x-request-id', requestId);
      response
        .status(problem.status)
        .type('application/problem+json')
        .send(JSON.stringify(problem.body));
    } catch {
      const fallback = fallbackProblem({ requestId, instance, traceId });
      response
        .status(fallback.status)
        .type('application/problem+json')
        .send(JSON.stringify(fallback.body));
    }
  }

  /**
   * Express answers a known path called with the wrong method as "Cannot POST /x" (404). When `/x` exists for other
   * methods the right answer is `405` with an `Allow` header (S54 AS-07); a path nothing serves stays a 404.
   */
  private methodNotAllowed(
    exception: unknown,
    request: { method?: string; path?: string },
  ): AppError | undefined {
    if (
      !this.routeTable ||
      !(exception instanceof NotFoundException) ||
      !/^Cannot [A-Z]+ /.test(exception.message)
    )
      return undefined;
    const allowed = this.routeTable.allowedMethods(request.path ?? '');
    if (allowed.length === 0 || allowed.includes(request.method ?? ''))
      return undefined;
    return new AppError({
      code: PlatformCodes.method_not_allowed,
      status: 405,
      title: 'Method Not Allowed',
      detail: 'This method is not supported for this resource.',
      area: ErrorArea.DOMAIN,
      headers: { Allow: allowed.join(', ') },
    });
  }

  private logFailure(
    error: ReturnType<ErrorUtilsService['normalizeError']>,
    requestId: string,
    instance: string,
  ): void {
    const line = `[requestId: ${requestId}] HTTP ${error.status} ${error.code} ${instance} - ${error.name}: ${error.message}`;
    if (Number(error.status) >= 500)
      this.logger.error(
        line,
        [error.stack, ...(error.causes ?? []).map((c) => c.stack)]
          .filter(Boolean)
          .join('\nCaused by: '),
      );
    else this.logger.warn(line);
  }
}
