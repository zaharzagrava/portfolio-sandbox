import { z } from 'zod';

export const searchClickRequestSchema = z
  .object({
    searchId: z.string().min(1).max(2_000),
    productId: z.string().uuid(),
    position: z.number().int().min(0).max(99),
  })
  .strict();
export type SearchClickRequest = z.infer<typeof searchClickRequestSchema>;
