import { z } from 'zod';

/**
 * S45 seller discount functions: request and response schemas of the `/shops/:shopId/functions` routes
 * (specs/domains/S45-discount-functions/contracts/api.md). Request objects are strict: an unknown field is a
 * `400 validation_failed`. Pages use tenancy's `pageSchema`; errors use `problemDetailsSchema`.
 */
const uuid = z.string().uuid();
const instant = z.iso.datetime({ offset: true });

export const FUNCTION_NAME_MAX = 60;
export const TEST_NAME_MAX = 80;
export const SUITE_MAX_CASES = 50;
export const SUITE_MAX_BYTES = 256 * 1024;
export const SOURCE_MAX_CHARS = 20_000;
export const DISCOUNT_MESSAGE_MAX = 80;
export const DISCOUNTS_MAX = 50;
export const LINES_MAX = 50;

export const SHOP_FUNCTION_ERROR_CODES = [
  'validation_failed',
  'invalid_cursor',
  'invalid_test_case',
  'function_not_found',
  'version_not_found',
  'function_name_taken',
  'function_limit_reached',
  'version_limit_reached',
  'function_state_conflict',
  'version_not_activatable',
  'entitlement_required',
  'forbidden',
  'unauthenticated',
  'rate_limited',
] as const;
export type ShopFunctionErrorCode = (typeof SHOP_FUNCTION_ERROR_CODES)[number];

export const VERSION_STATUSES = [
  'QUEUED',
  'TESTING',
  'ACTIVE',
  'REJECTED',
  'SUPERSEDED',
] as const;
export const versionStatusSchema = z.enum(VERSION_STATUSES);
export type VersionStatus = z.infer<typeof versionStatusSchema>;

export const VERDICTS = [
  'pass',
  'wrong-output',
  'timeout',
  'memory',
  'runtime',
  'invalid-output',
  'compile-error',
  'entry-missing',
] as const;
export const verdictKindSchema = z.enum(VERDICTS);
export type VerdictKind = z.infer<typeof verdictKindSchema>;

/** What seller code receives (the same shape a test case carries as its input). */
export const functionInputSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    lines: z
      .array(
        z
          .object({
            productId: z.string().min(1).max(100),
            category: z.string().max(100),
            quantity: z.number().int().min(1).max(1000),
            unitPriceMinor: z.number().int().min(0).max(1_000_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(LINES_MAX),
  })
  .strict();
export type FunctionInputDto = z.infer<typeof functionInputSchema>;

/** What seller code may return. */
export const functionOutputSchema = z
  .object({
    discounts: z
      .array(
        z
          .object({
            lineIndex: z.number().int().min(0),
            type: z.enum(['percentage', 'fixedPerUnit']),
            value: z.number().positive().max(1_000_000),
            message: z.string().max(DISCOUNT_MESSAGE_MAX),
          })
          .strict(),
      )
      .max(DISCOUNTS_MAX),
  })
  .strict();
export type FunctionOutputDto = z.infer<typeof functionOutputSchema>;

export const shopFunctionTestSchema = z
  .object({
    name: z.string().min(1).max(TEST_NAME_MAX),
    input: functionInputSchema,
    expected: functionOutputSchema,
  })
  .strict();
export type ShopFunctionTest = z.infer<typeof shopFunctionTestSchema>;

export const testSuiteSchema = z
  .array(shopFunctionTestSchema)
  .min(1)
  .max(SUITE_MAX_CASES)
  .refine((tests) => new Set(tests.map((t) => t.name)).size === tests.length, {
    message: 'test names must be unique',
  });

export const createShopFunctionSchema = z
  .object({
    name: z.string().trim().min(1).max(FUNCTION_NAME_MAX),
    tests: testSuiteSchema,
  })
  .strict();
export const replaceTestsSchema = z.object({ tests: testSuiteSchema }).strict();
export const submitVersionSchema = z
  .object({ source: z.string().min(1).max(SOURCE_MAX_CHARS) })
  .strict();

export const breakerSchema = z.object({
  state: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']),
  openUntil: instant.nullable(),
  lastFailure: z.object({ reason: z.string(), at: instant }).nullable(),
});

export const shopFunctionSchema = z.object({
  id: uuid,
  shopId: uuid,
  name: z.string(),
  enabled: z.boolean(),
  activeVersion: z.number().int().nullable(),
  latestVersion: z.number().int().nullable(),
  testCount: z.number().int().nonnegative(),
  breaker: breakerSchema,
  createdAt: instant,
  updatedAt: instant,
});
export type ShopFunctionDto = z.infer<typeof shopFunctionSchema>;

export const verdictSchema = z.object({
  case: z.string(),
  verdict: verdictKindSchema,
  detail: z.string().max(300).optional(),
  actual: z.unknown().optional(),
  ms: z.number(),
});
export type Verdict = z.infer<typeof verdictSchema>;

export const shopFunctionVersionSummarySchema = z.object({
  functionId: uuid,
  version: z.number().int().min(1),
  status: versionStatusSchema,
  sourceHash: z.string().length(64),
  verdicts: z.array(verdictSchema).nullable(),
  rejectionReason: z.literal('judge_unavailable').nullable(),
  judgeAttempts: z.number().int(),
  createdBy: uuid,
  createdAt: instant,
  judgedAt: instant.nullable(),
});

export const shopFunctionVersionSchema =
  shopFunctionVersionSummarySchema.extend({
    source: z.string(),
    timeline: z.array(
      z.object({
        status: versionStatusSchema,
        at: instant,
        actorId: uuid.nullable(),
        reason: z.string().nullable(),
      }),
    ),
  });
export type ShopFunctionVersionDto = z.infer<typeof shopFunctionVersionSchema>;

export const submittedVersionSchema = z.object({
  functionId: uuid,
  version: z.number().int().min(1),
  status: z.literal('QUEUED'),
  createdAt: instant,
});

export const testsBodySchema = z.object({
  tests: z.array(shopFunctionTestSchema),
});
