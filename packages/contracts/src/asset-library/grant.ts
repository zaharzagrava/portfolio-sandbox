import { z } from 'zod';

/** A buyer's download link (`POST /me/purchases/:productId/download`). */
export const downloadGrantSchema = z
  .object({
    url: z.string(),
    expiresAt: z.string(),
    expiresInSec: z.literal(600),
  })
  .strict();
export type DownloadGrant = z.infer<typeof downloadGrantSchema>;
