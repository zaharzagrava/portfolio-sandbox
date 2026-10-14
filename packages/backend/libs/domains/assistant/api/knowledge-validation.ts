import {
  CanActivate,
  ExecutionContext,
  Injectable,
  PipeTransform,
  Type,
} from '@nestjs/common';
import type { z } from 'zod';
import { validationFailed } from '../domain/knowledge-errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fieldsOf = (error: z.ZodError): string[] => [
  ...new Set(
    error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys'
        ? issue.keys
        : [String(issue.path[0] ?? 'body')],
    ),
  ),
];

/**
 * Validates and replaces the request body with a contract schema BEFORE the rate limit interceptor runs (guards run
 * before interceptors): S47 AS-14 puts request validation ahead of the limit, and an invalid request must not use up
 * a caller's allowance. Optionally checks path parameters that must be UUIDs. A failure is `400 validation_failed` naming
 * the fields, never their values. Declare it ABOVE `ShopScoped` / `Firewall` so authentication runs first (401, 404).
 */
export function ValidatedRequest(options: {
  body?: z.ZodType;
  uuidParams?: string[];
}): Type<CanActivate> {
  @Injectable()
  class ValidatedRequestGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest();
      const bad = (options.uuidParams ?? []).filter(
        (name) => !UUID.test(String(req.params?.[name] ?? '')),
      );
      if (bad.length) throw validationFailed(bad);
      if (options.body) {
        const parsed = options.body.safeParse(req.body ?? {});
        if (!parsed.success) throw validationFailed(fieldsOf(parsed.error));
        req.body = parsed.data;
      }
      return true;
    }
  }
  return ValidatedRequestGuard;
}

/** Parses a query string (or any value) with a contract schema; a failure is `400 validation_failed`. */
export class KnowledgeZodPipe<S extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<S>
> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;
    throw validationFailed(fieldsOf(parsed.error));
  }
}
