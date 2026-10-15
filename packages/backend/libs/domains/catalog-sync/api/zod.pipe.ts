import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppError, ErrorArea, PlatformCodes } from '@app/common/errors';

const validationFailed = (errors: Array<{ field: string; code: string }>) =>
  new AppError({
    code: PlatformCodes.validation_failed,
    status: 400,
    title: 'Bad Request',
    detail: 'The request is not valid.',
    area: ErrorArea.DOMAIN,
    extensions: { errors },
  });

/** Parses a body, query or path value with a contract schema; failures are `400 validation_failed` without echoed values. */
@Injectable()
export class ZodPipe<S extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<S>
> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw validationFailed(
      parsed.error.issues.slice(0, 20).map((issue) => ({
        field: issue.path.join('.') || 'value',
        code: issue.code,
      })),
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id that must be a UUID: otherwise `400 validation_failed` with `errors: [{field: <param name>, code: 'invalid_uuid'}]` (AS-72). */
@Injectable()
export class UuidParamPipe implements PipeTransform<unknown, string> {
  transform(value: unknown, metadata: ArgumentMetadata): string {
    if (typeof value === 'string' && UUID.test(value)) return value;
    throw validationFailed([
      { field: metadata.data ?? 'id', code: 'invalid_uuid' },
    ]);
  }
}
