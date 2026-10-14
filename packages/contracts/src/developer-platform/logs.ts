import { z } from 'zod';

/** S42 dashboard request log and usage report (contracts/http.md section B). */
const instant = z.iso.datetime({ offset: true });

export const requestLogRowSchema = z.object({
  requestId: z.string(),
  clientRequestId: z.string().nullable(),
  keyId: z.string(),
  livemode: z.boolean(),
  version: z.string(),
  method: z.string(),
  route: z.string(),
  status: z.number().int(),
  durationMs: z.number().int(),
  deprecated: z.boolean(),
  errorCode: z.string().nullable(),
  batchOps: z.number().int(),
  idempotentReplay: z.boolean(),
  at: instant,
});
export type RequestLogRow = z.infer<typeof requestLogRowSchema>;

export const requestLogQuerySchema = z
  .object({
    requestId: z.string().max(128).optional(),
    status: z.enum(['2xx', '3xx', '4xx', '5xx']).optional(),
    route: z.string().max(200).optional(),
    keyId: z.string().max(64).optional(),
    livemode: z.enum(['true', 'false']).optional(),
    from: instant.optional(),
    to: instant.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export const requestLogPageSchema = z.object({
  items: z.array(requestLogRowSchema),
  nextCursor: z.string().nullable(),
});

export const usageQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(30).default(7),
    livemode: z.enum(['true', 'false']).optional(),
    deprecated: z.enum(['true', 'false']).optional(),
  })
  .strict();

export const usageReportSchema = z.object({
  days: z.array(
    z.object({
      day: z.string(),
      version: z.string(),
      route: z.string(),
      calls: z.number().int(),
      errors: z.number().int(),
      deprecatedCalls: z.number().int(),
    }),
  ),
  keys: z.array(
    z.object({
      keyId: z.string(),
      version: z.string(),
      route: z.string(),
      calls: z.number().int(),
      errors: z.number().int(),
      lastCallAt: instant,
    }),
  ),
});
export type UsageReport = z.infer<typeof usageReportSchema>;
