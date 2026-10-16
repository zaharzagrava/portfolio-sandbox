import { z } from 'zod';
import {
  ASSET_CHUNK_MAX_BYTES,
  ASSET_HASH_PATTERN,
  ASSET_PREPARE_MAX_CHUNKS,
} from './limits.ts';

export const assetHashSchema = z.string().regex(ASSET_HASH_PATTERN);

export const assetPrepareRequestSchema = z
  .object({
    chunks: z
      .array(
        z
          .object({
            hash: assetHashSchema,
            size: z.number().int().min(1).max(ASSET_CHUNK_MAX_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(ASSET_PREPARE_MAX_CHUNKS),
  })
  .strict();
export type AssetPrepareRequest = z.infer<typeof assetPrepareRequestSchema>;

export const assetPrepareResponseSchema = z
  .object({
    missing: z.array(
      z
        .object({
          hash: assetHashSchema,
          url: z.string(),
          headers: z.record(z.string(), z.string()),
          expiresAt: z.string(),
        })
        .strict(),
    ),
    alreadyStored: z.number().int().min(0),
  })
  .strict();
export type AssetPrepareResponse = z.infer<typeof assetPrepareResponseSchema>;
