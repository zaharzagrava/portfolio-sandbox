import { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiError } from '../domain/errors';

/**
 * Validates a body with a contract schema. Used where a body can hold thousands of items (bulk stock): the decorator
 * based pipe would block the event loop for seconds on 10,000 items and trip the platform's load shedding. Failures are
 * the same `400 validation_failed` with `errors[{field, code}]` and no echoed values.
 */
export class ZodBodyPipe<S extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: S) {}

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
      else errors.push({ field: base || 'body', code: issue.code });
      if (errors.length >= 50) break;
    }
    throw new ApiError('validation_failed', 'The request is not valid.', {
      errors,
    });
  }
}
