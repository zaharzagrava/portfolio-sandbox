import { z } from 'zod';
import {
  SUITE_MAX_BYTES,
  createShopFunctionSchema,
  replaceTestsSchema,
} from '@marketplace-sandbox/contracts';
import { FunctionOutput } from '../domain/contract';
import {
  functionNotFound,
  functionValidationFailed,
  invalidTestCase,
} from '../domain/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pathOf = (issue: z.core.$ZodIssue) => issue.path.map(String).join('.');

/** Field names the schema reports, never their values; an unknown key is reported under its own name. */
export const fieldsOf = (error: z.ZodError): string[] => [
  ...new Set(
    error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys'
        ? (issue.keys as string[])
        : [issue.path.length ? pathOf(issue) : 'body'],
    ),
  ),
];

export function parseBody<S extends z.ZodType>(
  schema: S,
  body: unknown,
): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw functionValidationFailed(fieldsOf(parsed.error));
  return parsed.data;
}

/** A function id that is not a UUID is the same `404 function_not_found` as an unknown one (AS-04). */
export const functionIdOf = (raw: string): string => {
  if (!UUID.test(raw)) throw functionNotFound();
  return raw.toLowerCase();
};

type SuiteBody = {
  tests: Array<{ name: string; input: unknown; expected: unknown }>;
};
type Body = {
  tests: Array<{
    name: string;
    input: { lines: unknown[] };
    expected: unknown;
  }>;
};

const nameAt = (body: unknown, index: number): string => {
  const name = (body as { tests?: Array<{ name?: unknown }> })?.tests?.[index]
    ?.name;
  return typeof name === 'string' && name ? name : `#${index}`;
};

/**
 * Create and replace bodies (AS-02). Anything structural is `400 validation_failed` naming the field. A case whose
 * `expected` is not a valid function output for its own input, or two cases that share a name, is
 * `422 invalid_test_case` naming the case and the field. Nothing is stored either way.
 */
function parseSuiteBody<S extends z.ZodType<SuiteBody>>(
  schema: S,
  body: unknown,
): z.infer<S> {
  if (Buffer.byteLength(JSON.stringify(body ?? {})) > SUITE_MAX_BYTES)
    throw functionValidationFailed(['tests']);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const isSemantic = (i: z.core.$ZodIssue) =>
      i.path[0] === 'tests' &&
      typeof i.path[1] === 'number' &&
      i.path[2] === 'expected' &&
      i.code !== 'unrecognized_keys';
    const isDuplicate = (i: z.core.$ZodIssue) =>
      i.path.length === 1 && i.path[0] === 'tests' && i.code === 'custom';
    const structural = parsed.error.issues.filter(
      (i) => !isSemantic(i) && !isDuplicate(i),
    );
    if (structural.length > 0)
      throw functionValidationFailed(
        fieldsOf(new z.ZodError(structural as z.core.$ZodIssue[])),
      );
    const semantic = parsed.error.issues.find(isSemantic);
    if (semantic)
      throw invalidTestCase(
        nameAt(body, semantic.path[1] as number),
        pathOf(semantic).split('.').slice(2).join('.'),
      );
    const names = (body as Body).tests.map((t) => t.name);
    const duplicate = names.find((n, i) => names.indexOf(n) !== i) ?? '';
    throw invalidTestCase(duplicate, 'name');
  }
  // The contract schema cannot see across fields: every `lineIndex` must name a line of the same case's input.
  (parsed.data as Body).tests.forEach((test, index) => {
    const out = FunctionOutput.safeParse(test.expected);
    const discounts = out.success ? out.data.discounts : [];
    const bad = discounts.findIndex(
      (d) => d.lineIndex >= test.input.lines.length,
    );
    if (!out.success)
      throw invalidTestCase(nameAt(parsed.data, index), 'expected');
    if (bad >= 0)
      throw invalidTestCase(
        nameAt(parsed.data, index),
        `expected.discounts.${bad}.lineIndex`,
      );
  });
  return parsed.data;
}

export const parseCreateBody = (body: unknown) =>
  parseSuiteBody(createShopFunctionSchema, body);
export const parseReplaceBody = (body: unknown) =>
  parseSuiteBody(replaceTestsSchema, body);
