import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { validationFailed, type FieldIssue } from '../domain/errors';
import { isLocale } from '../domain/locale-chain';

/** Fixed text per issue: the submitted value is never echoed. */
export function fieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({
          field: [...issue.path, key].join('.'),
          code: 'unknown_property',
        }))
      : [{ field: issue.path.join('.') || 'body', code: issue.code }],
  );
}

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

/** A path id that must be a UUID: anything else is `400 validation_failed` naming the parameter (S27 AS-92). */
export class UuidParamPipe implements PipeTransform<string, string> {
  constructor(private readonly name: string) {}

  transform(value: string): string {
    if (!UUID.test(value))
      throw validationFailed([{ field: this.name, code: 'invalid' }]);
    return value.toLowerCase();
  }
}

/** A staff locale in a path: `xx` or `xx-XX`, else `400 validation_failed` (S27 AS-10). */
export class LocaleParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isLocale(value))
      throw validationFailed([{ field: 'locale', code: 'invalid' }]);
    return value;
  }
}

/** A version number in a path: a positive integer; anything else is an unknown version and the caller says `404`. */
export class VersionParamPipe implements PipeTransform<string, number> {
  constructor(private readonly onInvalid: () => Error) {}

  transform(value: string): number {
    if (!/^[1-9]\d{0,8}$/.test(value)) throw this.onInvalid();
    return Number(value);
  }
}

/** A query integer within bounds: `400 validation_failed` otherwise (never a silent default for a wrong value). */
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
    // the global pipe may already have turned the text into a number
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !/^-?\d{1,15}$/.test(text))
      throw validationFailed([{ field: this.name, code: 'not_an_integer' }]);
    const n = Number(text);
    if (n < this.min || n > this.max)
      throw validationFailed([{ field: this.name, code: 'out_of_range' }]);
    return n;
  }
}
