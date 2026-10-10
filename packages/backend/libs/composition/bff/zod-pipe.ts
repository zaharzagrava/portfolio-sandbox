import { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { BffProblem } from './problem';

/** Parses a path, query or body value with a contract schema; failures are `400 validation_failed` without echoing values. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new BffProblem('validation_failed', {
      extensions: {
        errors: parsed.error.issues.slice(0, 20).map((issue) => ({
          field: issue.path.join('.') || 'value',
          code: issue.code,
        })),
      },
    });
  }
}
