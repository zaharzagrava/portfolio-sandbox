import { z } from "zod";
import { statementPeriodStatusSchema } from "./statements.ts";

/** S16 accounting-period HTTP contracts (contracts/http.md): operator side, platform admin only. */
const isoDateTime = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

export const periodWatermarksSchema = z.strictObject({
  orders: isoDateTime.nullable(),
  payouts: isoDateTime.nullable(),
  ledger: isoDateTime.nullable(),
});

export const periodRunStatusSchema = z.enum(["RUNNING", "COMPLETED", "FAILED"]);

export const accountingPeriodSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  status: statementPeriodStatusSchema,
  knowledgeCutoff: isoDateTime.nullable(),
  closedAt: isoDateTime.nullable(),
  shopCount: z.number().int().nullable(),
  watermarks: periodWatermarksSchema,
  lastRun: z
    .strictObject({
      runId: uuid,
      status: periodRunStatusSchema,
      failureCode: z.string().nullable(),
      startedAt: isoDateTime,
      finishedAt: isoDateTime.nullable(),
    })
    .nullable(),
  reconciliation: z.enum(["clean", "findings", "unverified"]),
});
export type AccountingPeriod = z.infer<typeof accountingPeriodSchema>;

export const accountingPeriodPageSchema = z.strictObject({
  items: z.array(accountingPeriodSchema),
  nextCursor: z.string().nullable(),
});

export const periodCloseAcceptedSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  status: z.literal("CLOSING"),
  runId: uuid,
});
export type PeriodCloseAccepted = z.infer<typeof periodCloseAcceptedSchema>;
