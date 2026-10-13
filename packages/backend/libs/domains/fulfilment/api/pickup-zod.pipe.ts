import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { fieldsOf } from '../domain/geo-input';
import { PickupValidationError } from '../domain/pickup-errors';

/** Parses a body or query with a contract schema; a failure is `400 validation_failed` naming fields, never values. */
export class PickupZodPipe<S extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<S>
> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new PickupValidationError(fieldsOf(parsed.error));
  }
}
