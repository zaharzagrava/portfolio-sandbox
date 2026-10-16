import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { validationFailed } from '../domain/errors';
import { fieldIssues } from '../domain/field-issues';

/** Validates a body with a contract schema: `400 validation_failed` with `errors: [{field, code}]`. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const parsed = this.schema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;
    throw validationFailed(fieldIssues(parsed.error));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id that must be a UUID: anything else is `400 validation_failed` naming the parameter. */
export class UuidParamPipe implements PipeTransform<string, string> {
  constructor(private readonly name: string) {}

  transform(value: string): string {
    if (!UUID.test(value))
      throw validationFailed([{ field: this.name, code: 'invalid' }]);
    return value.toLowerCase();
  }
}

/** A query integer within bounds: `400 validation_failed` otherwise. */
export class IntQueryPipe implements PipeTransform<unknown, number> {
  constructor(
    private readonly name: string,
    private readonly min: number,
    private readonly max: number,
    private readonly fallback?: number,
  ) {}

  transform(value: unknown): number {
    if (value === undefined || value === '') {
      if (this.fallback !== undefined) return this.fallback;
      throw validationFailed([{ field: this.name, code: 'required' }]);
    }
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !/^-?\d{1,15}$/.test(text))
      throw validationFailed([{ field: this.name, code: 'not_an_integer' }]);
    const n = Number(text);
    if (n < this.min || n > this.max)
      throw validationFailed([{ field: this.name, code: 'out_of_range' }]);
    return n;
  }
}
