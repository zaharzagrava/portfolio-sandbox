import type { z } from 'zod';
import type { FieldIssue } from './errors';

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
