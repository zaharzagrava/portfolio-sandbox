import { z } from 'zod';
import { assetHashSchema } from './prepare.ts';

export const assetManifestSchema = z
  .object({
    assetId: z.string().uuid(),
    version: z.number().int().min(1),
    sizeBytes: z.number().int().min(0),
    chunks: z.array(
      z
        .object({
          index: z.number().int().min(0),
          hash: assetHashSchema,
          sizeBytes: z.number().int().min(1),
          url: z.string(),
        })
        .strict(),
    ),
    totalChunks: z.number().int().min(0),
    nextFrom: z.number().int().min(1).nullable(),
  })
  .strict();
export type AssetManifest = z.infer<typeof assetManifestSchema>;
