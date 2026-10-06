import { HttpException, Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { Environment } from '@app/common/types';
import {
  AppError,
  BadRequestError,
  ErrorArea,
  InternalServerError,
} from '../error.types';
import { ApiConfigService } from '@app/common/config/api-config.service';

@Injectable()
export class ErrorUtilsService {
  private readonly l = new Logger(ErrorUtilsService.name);

  constructor(private readonly configService: ApiConfigService) { }

  public captureSentryException(error: any): Error {
    if (this.configService.get('node_env') === Environment.test) return error;

    const formattedError = this.normalizeError(error);
    Sentry.captureException(error, {
      extra: {
        theData: JSON.stringify(formattedError.toJSON(true)),
      },
    });

    return error;
  }

  public normalizeError(exception: unknown): AppError {
    if (exception instanceof AppError) return exception;

    const errorObj =
      exception instanceof Error ? exception : new Error(String(exception));

    // NestJS HttpExceptions (ValidationPipe, guards, Unauthorized/Forbidden, ...)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse() as any;

      // NestJS puts validation arrays in response.message
      const detail =
        typeof response === 'string'
          ? response
          : response?.message || exception.message;

      return new AppError({
        detail: Array.isArray(detail) ? detail.join(', ') : String(detail),
        title: 'HTTP Exception',
        status,
        area: status >= 500 ? ErrorArea.FATAL : ErrorArea.DOMAIN,
        causes: [errorObj],
      });
    }

    if (errorObj.name.startsWith('Sequelize')) {
      if (errorObj.name === 'SequelizeUniqueConstraintError') {
        return new BadRequestError('A record with this data already exists.', {
          title: 'Database Conflict',
          causes: [errorObj],
        });
      }
      if (errorObj.name === 'SequelizeValidationError') {
        return new BadRequestError('Invalid data provided to the database.', {
          title: 'Database Validation Failed',
          causes: [errorObj],
        });
      }

      return new InternalServerError('Database operation failed.', {
        causes: [errorObj],
      });
    }

    return new InternalServerError('An unexpected internal error occurred.', {
      causes: [errorObj],
    });
  }
}
