import { z } from 'zod';
import {
  createStoryRequestSchema,
  saveDraftRequestSchema,
} from '@marketplace-sandbox/contracts';
import type { FieldIssue } from './errors';

const SLUG = /^[a-z0-9][a-z0-9-]{1,80}$/;
export const isSlug = (value: string): boolean => SLUG.test(value);

export type Input<T> =
  { ok: true; value: T } | { ok: false; issues: FieldIssue[] };

/** Fixed text per issue: the submitted value is never echoed. */
function fieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({
          field: [...issue.path, key].join('.'),
          code: 'unknown_property',
        }))
      : [{ field: issue.path.join('.') || 'body', code: issue.code }],
  );
}

function parseWith<S extends z.ZodType>(
  schema: S,
  body: unknown,
): Input<z.infer<S>> {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: fieldIssues(parsed.error) };
}

/** `{slug, defaultLocale?}`; an omitted default locale is `en` (S27 AS-01). */
export function parseCreateStory(
  body: unknown,
): Input<{ slug: string; defaultLocale: string }> {
  const parsed = parseWith(createStoryRequestSchema, body);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      slug: parsed.value.slug,
      defaultLocale: parsed.value.defaultLocale ?? 'en',
    },
  };
}

/** The envelope of a draft write; block and title rules follow in the application (they carry their own codes). */
export function parseDraftInput(
  body: unknown,
): Input<z.infer<typeof saveDraftRequestSchema>> {
  return parseWith(saveDraftRequestSchema, body);
}
