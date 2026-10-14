import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { validationFailed } from '../domain/flag-errors';

const fieldsOf = (error: z.ZodError): string[] => [
  ...new Set(
    error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys'
        ? issue.keys
        : [String(issue.path[0] ?? 'body')],
    ),
  ),
];

/** Parses a body, param or query with a contract schema; a failure is `400 validation_failed` naming fields, never values. */
export class FlagZodPipe<S extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<S>
> {
  constructor(
    private readonly schema: S,
    private readonly field?: string,
  ) {}

  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;
    throw validationFailed(this.field ? [this.field] : fieldsOf(parsed.error));
  }
}
