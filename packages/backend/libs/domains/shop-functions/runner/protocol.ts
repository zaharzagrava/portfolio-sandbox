import { z } from 'zod';
import { TestCase, VerdictSchema } from '../domain/contract';

/**
 * The coordinator ↔ function-runner protocol (contracts/internal.md): newline-delimited JSON over a Unix domain socket,
 * one connection per version. Both directions are parsed strictly: neither side trusts the other's bytes.
 */
export const runnerRequestSchema = z
  .object({
    runId: z.string().uuid(),
    source: z.string().min(1).max(20_000),
    cases: z.array(TestCase).min(1).max(50),
    caseBudgetMs: z.number().int().min(1).max(1_000),
    totalBudgetMs: z.number().int().min(100).max(60_000),
  })
  .strict();
export type RunnerRequestMessage = z.infer<typeof runnerRequestSchema>;

export const runnerReplySchema = z.union([
  z
    .object({
      runId: z.string().uuid(),
      verdicts: z.array(VerdictSchema).max(50),
    })
    .strict(),
  z
    .object({ runId: z.string().uuid(), error: z.enum(['budget', 'internal']) })
    .strict(),
]);
export type RunnerReply = z.infer<typeof runnerReplySchema>;

/** A request line is never longer than the suite cap plus the source (256 KiB + 20,000 + slack). */
export const MAX_REQUEST_BYTES = 512 * 1024;
