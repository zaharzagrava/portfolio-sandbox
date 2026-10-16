import { z } from 'zod';

export const previewTokenSchema = z
  .object({ token: z.string(), expiresAt: z.string() })
  .strict();
