import { Catch, ArgumentsHost, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import { trace } from '@opentelemetry/api';
import { ErrorUtilsService } from '@app/common/errors/error-utils/error-utils.service';

@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly utilsService: ErrorUtilsService) {
    super();
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    // 1. Normalize the error into our standard AppError format
    const appError = this.utilsService.normalizeError(exception);

    // 2. Determine environment (Secure by default!)
    const isDevelopment = process.env.NODE_ENV !== 'production';

    // 3. Generate the payloads
    // The frontend ONLY gets debug data if we are not in production
    const publicPayload = appError.toJSON(isDevelopment);
    // Observability tools ALWAYS get the full debug data
    const internalPayload = appError.toJSON(true);

    // 4. OpenTelemetry Integration
    const activeSpan = trace.getActiveSpan();
    let traceId = 'no-trace-id';

    if (activeSpan) {
      traceId = activeSpan.spanContext().traceId;

      activeSpan.recordException(appError);
      // We inject the FULL internal payload into Datadog
      activeSpan.setAttributes({
        'error.type': internalPayload.type,
        'error.title': internalPayload.title,
        'error.debug_data': JSON.stringify(internalPayload.data || {}),
        'error.causes': JSON.stringify(internalPayload.causes || []),
        'http.status_code': appError.status,
      });
      activeSpan.setStatus({ code: 2, message: appError.message });
    }

    // 5. Sentry Integration
    if (appError.status >= 500) {
      // Pass the raw AppError to preserve V8 stack traces and native cause chains
      Sentry.captureException(appError, {
        tags: { trace_id: traceId },
        extra: {
          path: request.url,
          fullErrorState: internalPayload, // Sentry gets the juicy details
        },
      });
    }

    // 6. Standard Console Logging
    this.logger.error(
      `[Trace: ${traceId}] HTTP ${appError.status} - ${appError.name}: ${appError.message}`,
      appError.stack,
    );

    // 7. Send the SAFE response to the client as RFC 9457 Problem Details
    const requestId = response.getHeader?.('x-request-id');
    response
      .status(appError.status)
      .type('application/problem+json')
      .json({
        ...publicPayload,
        instance: publicPayload.instance ?? request.originalUrl ?? request.url,
        supportTraceId: traceId,
        ...(requestId && { requestId }),
      });
  }
}