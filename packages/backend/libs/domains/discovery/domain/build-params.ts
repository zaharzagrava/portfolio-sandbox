import { z } from 'zod';

/** Payload of `recommendations.build-bought-together` (S34 FR-018): bounded integers, unknown keys rejected. */
export const BUILD_LIMITS = {
  days: { min: 1, max: 390 },
  buckets: { min: 1, max: 256 },
} as const;

export const buildPayloadContract = z
  .object({
    days: z
      .number()
      .int()
      .min(BUILD_LIMITS.days.min)
      .max(BUILD_LIMITS.days.max)
      .optional(),
    buckets: z
      .number()
      .int()
      .min(BUILD_LIMITS.buckets.min)
      .max(BUILD_LIMITS.buckets.max)
      .optional(),
  })
  .strict();

export interface BuildParams {
  days: number;
  buckets: number;
}

export type BuildParamsResult =
  | { ok: true; value: BuildParams }
  | { ok: false; fields: string[] };

/** Applies the defaults to a valid payload; an invalid one names the offending keys (never their values). */
export function parseBuildParams(
  raw: unknown,
  defaults: BuildParams,
): BuildParamsResult {
  const parsed = buildPayloadContract.safeParse(raw ?? {});
  if (!parsed.success) {
    const fields = new Set<string>();
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys')
        for (const key of issue.keys) fields.add(key);
      else fields.add(issue.path.length > 0 ? String(issue.path[0]) : 'payload');
    }
    return { ok: false, fields: [...fields] };
  }
  return {
    ok: true,
    value: {
      days: parsed.data.days ?? defaults.days,
      buckets: parsed.data.buckets ?? defaults.buckets,
    },
  };
}
