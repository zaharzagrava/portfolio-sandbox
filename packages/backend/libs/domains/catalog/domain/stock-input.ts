import { z } from 'zod';
import {
  PRODUCT_LIMITS,
  productCreateRequestSchema,
} from '@marketplace-sandbox/contracts';
import type { ParseResult } from './product-input';

export interface StockOperation {
  operationId: string;
  productId: string;
  shopId: string;
  delta: number;
  reason: string;
}

const operationSchema = z
  .object({
    operationId: z.string().min(1).max(128),
    productId: z.string().uuid(),
    shopId: z.string().uuid(),
    delta: z
      .number()
      .int()
      .min(-PRODUCT_LIMITS.stockDelta.max)
      .max(PRODUCT_LIMITS.stockDelta.max)
      .refine((d) => d !== 0),
    reason: z.string().regex(/^[a-z0-9._-]{1,64}$/),
  })
  .strict();

const operationsSchema = z
  .array(operationSchema)
  .min(1)
  .max(PRODUCT_LIMITS.stockOperationsPerCall)
  .refine((ops) => new Set(ops.map((o) => o.operationId)).size === ops.length, {
    message: 'operationId must be distinct within a call',
  });

const fieldsOf = (error: z.ZodError): string[] => [
  ...new Set(
    error.issues.map((issue) =>
      issue.path.length > 0 ? issue.path.join('.') : 'operations',
    ),
  ),
];

/** 1 to 100 operations, distinct ids, non-zero integer deltas within +-1,000,000, a `[a-z0-9._-]{1,64}` reason (AS-57). */
export function parseStockOperations(
  raw: unknown,
): ParseResult<StockOperation[]> {
  const parsed = operationsSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, fields: fieldsOf(parsed.error) };
}

/** One external product: the create rules minus the currency, plus the caller's own id (`externalSku`, 1–128). */
export const externalItemSchema = productCreateRequestSchema
  .omit({ currency: true })
  .extend({
    externalSku: z
      .string()
      .min(PRODUCT_LIMITS.externalSku.min)
      .max(PRODUCT_LIMITS.externalSku.max),
  });
export type ExternalItem = z.infer<typeof externalItemSchema>;

export function parseExternalItem(raw: unknown): ParseResult<ExternalItem> {
  const parsed = externalItemSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const fields = new Set<string>();
  for (const issue of parsed.error.issues) {
    if (issue.code === 'unrecognized_keys')
      for (const key of issue.keys) fields.add(key);
    else fields.add(issue.path.length > 0 ? String(issue.path[0]) : '(item)');
  }
  return { ok: false, fields: [...fields] };
}
