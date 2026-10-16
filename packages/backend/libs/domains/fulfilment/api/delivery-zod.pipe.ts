import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { DeliveryValidationError } from '../domain/delivery-errors';

/** Dotted paths of the failing fields (`points.0.lat`); unknown keys are named too. Never values. */
export const deliveryFieldsOf = (error: z.ZodError): string[] => [
  ...new Set(
    error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [...issue.path, key].join('.'))
        : [issue.path.length > 0 ? issue.path.join('.') : 'body'],
    ),
  ),
];

/** Parses a body, query or header set with a contract schema; a failure is `400 validation_failed` naming fields. */
export class DeliveryZodPipe<S extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<S>
> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new DeliveryValidationError(deliveryFieldsOf(parsed.error));
  }
}
