import { z } from 'zod';

/** S40 public top list (specs/domains/S40-leaderboards-dashboard/contracts/http-and-events.md). Strict: no revenue, no user id. */
export const boardPeriodKindSchema = z.enum(['week', 'month']);

export const boardPeriodSchema = z
  .object({
    kind: boardPeriodKindSchema,
    /** `2026-W41` / `2026-10` */
    id: z.string(),
    startsAt: z.string(),
    endsAt: z.string(),
    closed: z.boolean(),
  })
  .strict();
export type BoardPeriod = z.infer<typeof boardPeriodSchema>;

export const leaderboardEntrySchema = z
  .object({
    rank: z.number().int().positive(),
    shopId: z.string().uuid(),
    slug: z.string().nullable(),
    name: z.string().nullable(),
  })
  .strict();

export const leaderboardPageSchema = z
  .object({
    period: boardPeriodSchema,
    category: z.string().nullable(),
    source: z.enum(['live', 'snapshot']),
    generatedAt: z.string(),
    entries: z.array(leaderboardEntrySchema).max(100),
  })
  .strict();
export type LeaderboardPage = z.infer<typeof leaderboardPageSchema>;
