import { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppError, ErrorArea } from '@app/common/errors';

/**
 * Validates a value with a `packages/contracts` schema. A failure is `400 validation_failed` with `errors[{field, code}]`
 * naming the fields and never echoing a value (the text of a message is the user's own). `field` is the prefix for a
 * scalar (a path parameter or header).
 */
export class ZodPipe<S extends z.ZodType> implements PipeTransform {
  constructor(
    private readonly schema: S,
    private readonly field?: string,
  ) {}

  transform(value: unknown): z.infer<S> {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const errors: { field: string; code: string }[] = [];
    for (const issue of parsed.error.issues) {
      const base = issue.path.map(String).join('.');
      if (issue.code === 'unrecognized_keys')
        for (const key of issue.keys)
          errors.push({
            field: base ? `${base}.${key}` : key,
            code: 'unknown_property',
          });
      else
        errors.push({
          field: base || this.field || 'body',
          code: issue.code,
        });
      if (errors.length >= 50) break;
    }
    throw new AppError({
      code: 'validation_failed',
      status: 400,
      title: 'Bad Request',
      detail: 'The request is not valid.',
      area: ErrorArea.DOMAIN,
      extensions: { errors },
    });
  }
}
