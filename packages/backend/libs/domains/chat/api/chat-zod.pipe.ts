import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ChatValidationError } from '../domain/errors';

const fieldsOf = (error: z.ZodError): string[] => [
  ...new Set(
    error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys'
        ? issue.keys
        : [String(issue.path[0] ?? 'body')],
    ),
  ),
];

/** Parses a body or query with a contract schema; a failure is `400 validation_failed` naming fields, never values. */
export class ChatZodPipe<S extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<S>
> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;
    throw new ChatValidationError(fieldsOf(parsed.error));
  }
}
