import {
  ValidationError,
  ValidationPipe,
  ValidationPipeOptions,
} from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors/error.types';
import { PlatformCodes } from '@app/common/errors/platform-codes';

const flatten = (
  errors: ValidationError[],
  parent = '',
): { field: string; code: string }[] =>
  errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = Object.keys(e.constraints ?? {}).map((code) => ({
      field,
      // `whitelistValidation` is class-validator's constraint key for forbidden unknown properties.
      code: code === 'whitelistValidation' ? 'unknown_property' : code,
    }));
    return [...own, ...flatten(e.children ?? [], field)];
  });

/** ValidationPipe whose failures are `400 validation_failed` with `errors[{field, code}]` and no echoed values. */
export const createValidationPipe = (
  options: ValidationPipeOptions = {},
): ValidationPipe =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    validationError: { target: false, value: false },
    ...options,
    exceptionFactory: (errors) =>
      new AppError({
        code: PlatformCodes.validation_failed,
        status: 400,
        title: 'Bad Request',
        detail: 'The request is not valid.',
        area: ErrorArea.DOMAIN,
        extensions: { errors: flatten(errors) },
      }),
  });
