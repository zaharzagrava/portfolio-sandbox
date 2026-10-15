import { z } from 'zod';

/** S16 reconciliation findings (contracts/http.md): one per (month, kind, shop); `shopId` is null for platform-wide kinds. */
const isoDateTime = z.string().datetime({ offset: true });

export const reconciliationFindingKindSchema = z.enum([
  'net_mismatch',
  'fee_mismatch',
  'missing_in_ledger',
  'missing_in_statement',
  'completeness_violation',
]);
export type ReconciliationFindingKind = z.infer<
  typeof reconciliationFindingKindSchema
>;

export const reconciliationFindingSchema = z.strictObject({
  id: z.string().uuid(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  kind: reconciliationFindingKindSchema,
  shopId: z.string().uuid().nullable(),
  expectedMinor: z.number().int(),
  actualMinor: z.number().int(),
  differenceMinor: z.number().int(),
  status: z.enum(['OPEN', 'CLEARED']),
  openedAt: isoDateTime,
  clearedAt: isoDateTime.nullable(),
});

export const reconciliationFindingPageSchema = z.strictObject({
  items: z.array(reconciliationFindingSchema),
  nextCursor: z.string().nullable(),
});
export type ReconciliationFindingPage = z.infer<
  typeof reconciliationFindingPageSchema
>;
