import {
  ArgumentMetadata,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { z } from 'zod';
import { importValidationFailed } from '../domain/import-problems';

/**
 * Parses a body or query with a contract schema; a failure is `400 validation_failed` naming the fields, never the
 * values (S54: DTO failures are 400, not 422). An unknown key is named by the key itself.
 */
export class ImportZodPipe<S extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<S>
> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;
    throw importValidationFailed(
      [
        ...new Set(
          parsed.error.issues.flatMap((issue) =>
            issue.code === 'unrecognized_keys'
              ? issue.keys
              : [issue.path.join('.') || 'body'],
          ),
        ),
      ].slice(0, 20),
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id that must be a UUID, otherwise `400 validation_failed` naming the parameter (no database statement runs). */
@Injectable()
export class ImportUuidPipe implements PipeTransform<unknown, string> {
  transform(value: unknown, metadata: ArgumentMetadata): string {
    if (typeof value === 'string' && UUID.test(value)) return value;
    throw importValidationFailed([metadata.data ?? 'id']);
  }
}
