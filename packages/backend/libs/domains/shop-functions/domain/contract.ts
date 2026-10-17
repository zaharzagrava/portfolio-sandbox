import { z } from 'zod';
import {
  functionInputSchema,
  functionOutputSchema,
  shopFunctionTestSchema,
  verdictSchema,
  type FunctionInputDto,
  type FunctionOutputDto,
} from '@marketplace-sandbox/contracts';

/** What seller code receives: one shop's lines, no shop id, no personal data. Strict. */
export const FunctionInput = functionInputSchema;
export type FunctionInput = FunctionInputDto;

export const OUTPUT_MAX_BYTES = 64 * 1024;

const hasAtMostTwoDecimals = (value: number) =>
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

/**
 * What seller code may return: validated, never trusted (IV.8). `fixedPerUnit` is an integer, a percentage has at
 * most two decimals; unknown keys are refused.
 */
export const FunctionOutput = functionOutputSchema.superRefine((out, ctx) => {
  out.discounts.forEach((d, i) => {
    if (d.type === 'fixedPerUnit' && !Number.isInteger(d.value))
      ctx.addIssue({
        code: 'custom',
        path: ['discounts', i, 'value'],
        message: 'fixedPerUnit must be an integer',
      });
    if (d.type === 'percentage' && !hasAtMostTwoDecimals(d.value))
      ctx.addIssue({
        code: 'custom',
        path: ['discounts', i, 'value'],
        message: 'percentage allows at most two decimals',
      });
  });
});
export type FunctionOutput = FunctionOutputDto;

export const TestCase = shopFunctionTestSchema;
export type TestCase = z.infer<typeof TestCase>;

export const VerdictSchema = verdictSchema;
export type VerdictRecord = z.infer<typeof VerdictSchema>;

export type SandboxFailure =
  | 'timeout'
  | 'memory'
  | 'invalid-output'
  | 'runtime'
  | 'compile-error'
  | 'entry-missing';

export type SandboxResult =
  | { ok: true; output: FunctionOutput; ms: number }
  | { ok: false; error: SandboxFailure; detail: string; ms: number };

export type OutputCheck =
  { ok: true; output: FunctionOutput } | { ok: false; detail: string };

/** Parses a function's output against its input: strict shape, `lineIndex` within the lines, size cap. */
export function validateOutput(
  input: FunctionInput,
  raw: unknown,
  serialisedBytes?: number,
): OutputCheck {
  if (
    (serialisedBytes ?? Buffer.byteLength(JSON.stringify(raw ?? null))) >
    OUTPUT_MAX_BYTES
  )
    return { ok: false, detail: 'output exceeds 64 KiB' };
  const parsed = FunctionOutput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || 'output';
    return {
      ok: false,
      detail: `${where}: ${issue?.message ?? 'invalid'}`.slice(0, 300),
    };
  }
  const bad = parsed.data.discounts.findIndex(
    (d) => d.lineIndex >= input.lines.length,
  );
  if (bad >= 0)
    return {
      ok: false,
      detail: `discounts.${bad}.lineIndex: outside the input lines`,
    };
  return { ok: true, output: parsed.data };
}
