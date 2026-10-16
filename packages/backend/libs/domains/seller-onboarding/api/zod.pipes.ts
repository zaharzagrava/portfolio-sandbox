import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { fieldIssues } from '../domain/questionnaire';
import { OnboardingError, validationFailed } from '../domain/errors';

/**
 * Validates a body or query with a contract schema (S04 A15, A22): `400 validation_failed` with
 * `errors: [{path, message}]`; messages are fixed text, never the submitted value.
 */
export class ZodPipe<S extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const parsed = this.schema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;
    throw validationFailed(
      fieldIssues(parsed.error).map((i) => ({ ...i, path: i.path || 'body' })),
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path parameter that must be a UUID; anything else raises `onInvalid` (a 404 of the resource, AS-21, or a 400, AS-45). */
export class UuidParamPipe implements PipeTransform<string, string> {
  constructor(private readonly onInvalid: () => OnboardingError) {}

  transform(value: string): string {
    if (!UUID.test(value)) throw this.onInvalid();
    return value;
  }
}
