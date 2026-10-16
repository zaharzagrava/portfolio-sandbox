import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import {
  AssetError,
  validationFailed,
  type FieldIssue,
} from '../domain/errors';

/** Fixed text per issue: the submitted value is never echoed. */
export function fieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || 'body',
    code: issue.code === 'unrecognized_keys' ? 'unknown_property' : issue.code,
  }));
}

/** Validates a body or query with a contract schema: `400 validation_failed` with `errors: [{path, message}]`. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const parsed = this.schema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;
    throw validationFailed(fieldIssues(parsed.error));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path parameter that must be a UUID; anything else raises `onInvalid` (the 404 of the resource). */
export class UuidParamPipe implements PipeTransform<string, string> {
  constructor(private readonly onInvalid: () => AssetError) {}

  transform(value: string): string {
    if (!UUID.test(value)) throw this.onInvalid();
    return value;
  }
}

/** `?deleted=true|false`; anything else is a `400`. */
export class BoolQueryPipe implements PipeTransform<unknown, boolean> {
  constructor(private readonly name: string) {}

  transform(value: unknown): boolean {
    // the global pipe may already have turned the text into a boolean
    if (value === undefined || value === 'false' || value === false)
      return false;
    if (value === 'true' || value === true) return true;
    throw validationFailed([{ field: this.name, code: 'not_a_boolean' }]);
  }
}

/** A required query string value (the journal cursor): missing or repeated is a `400`. */
export class RequiredQueryPipe implements PipeTransform<unknown, string> {
  constructor(private readonly name: string) {}

  transform(value: unknown): string {
    if (typeof value !== 'string' || value === '')
      throw validationFailed([{ field: this.name, code: 'required' }]);
    return value;
  }
}

/** A path version number: a positive integer, anything else is an unknown version (`404`). */
export class VersionParamPipe implements PipeTransform<string, number> {
  constructor(private readonly onInvalid: () => AssetError) {}

  transform(value: string): number {
    if (!/^[1-9]\d{0,8}$/.test(value)) throw this.onInvalid();
    return Number(value);
  }
}

/** A query or path integer within bounds, as text: `400 validation_failed` otherwise (never a silent default). */
export class IntParamPipe implements PipeTransform<
  unknown,
  number | undefined
> {
  constructor(
    private readonly name: string,
    private readonly min: number,
    private readonly max: number,
    private readonly fallback?: number,
  ) {}

  transform(value: unknown): number | undefined {
    if (value === undefined || value === '') return this.fallback;
    // the global pipe may already have turned a numeric query string into a number
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !/^-?\d{1,15}$/.test(text))
      throw validationFailed([{ field: this.name, code: 'not_an_integer' }]);
    const n = Number(text);
    if (n < this.min || n > this.max)
      throw validationFailed([{ field: this.name, code: 'out_of_range' }]);
    return n;
  }
}
