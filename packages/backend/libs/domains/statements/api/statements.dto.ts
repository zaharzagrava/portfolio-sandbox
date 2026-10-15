import { z } from 'zod';
import {
  setCommissionRateRequestSchema,
  statementKnownAtSchema,
} from '@marketplace-sandbox/contracts';

/** Request schemas of the statements routes (contracts/http.md): zod pipes in `api/`, the only validation (II.1). */
const uuid = z.string().uuid();
const cursor = z.string().min(1).max(2048);
const isoInstant = z.string().datetime({ offset: true });

const limit = (max: number, fallback: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);

export const setRateBodySchema = setCommissionRateRequestSchema;

export const rateHistoryQuerySchema = z.strictObject({
  shopId: uuid.optional(),
  category: z.string().trim().min(1).max(64).optional(),
  limit: limit(100, 20),
  cursor: cursor.optional(),
});

export const rateAsOfQuerySchema = z.strictObject({
  shopId: uuid.optional(),
  category: z.string().trim().min(1).max(64),
  validAt: isoInstant,
  knownAt: isoInstant.optional(),
});

export const sellerListQuerySchema = z.strictObject({
  limit: limit(36, 12),
  cursor: cursor.optional(),
});

export const adminListQuerySchema = z.strictObject({
  limit: limit(100, 20),
  cursor: cursor.optional(),
});

export const statementQuerySchema = z.strictObject({
  knownAt: statementKnownAtSchema.optional(),
});

export const monthParamSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const shopIdParamSchema = uuid;
