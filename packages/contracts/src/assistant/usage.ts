import { z } from 'zod';

/** `GET /assistant/usage`: the caller's tokens used this UTC month, the plan's limit and the next reset (S46 AS-42). */
export const assistantUsageSchema = z
  .object({
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    resetsAt: z.iso.datetime(),
  })
  .strict();
export type AssistantUsage = z.infer<typeof assistantUsageSchema>;
