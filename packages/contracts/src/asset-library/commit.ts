import { z } from 'zod';
import {
  ASSET_COMMIT_MAX_CHUNKS,
  ASSET_DEVICE_ID_PATTERN,
  ASSET_FILE_MAX_BYTES,
} from './limits.ts';
import { assetHashSchema } from './prepare.ts';

export const ASSET_COMMIT_OUTCOMES = [
  'created',
  'updated',
  'conflicted_copy',
  'unchanged',
] as const;
export const assetCommitOutcomeSchema = z.enum(ASSET_COMMIT_OUTCOMES);
export type AssetCommitOutcome = z.infer<typeof assetCommitOutcomeSchema>;

export const assetCommitRequestSchema = z
  .object({
    path: z.string(),
    baseVersion: z.number().int().min(0),
    chunks: z.array(assetHashSchema).max(ASSET_COMMIT_MAX_CHUNKS),
    sizeBytes: z.number().int().min(0).max(ASSET_FILE_MAX_BYTES),
    deviceId: z.string().regex(ASSET_DEVICE_ID_PATTERN),
  })
  .strict();
export type AssetCommitRequest = z.infer<typeof assetCommitRequestSchema>;

export const assetCommitResponseSchema = z
  .object({
    assetId: z.string().uuid(),
    path: z.string(),
    version: z.number().int().min(1),
    outcome: assetCommitOutcomeSchema,
    conflicted: z.boolean(),
    sizeBytes: z.number().int().min(0),
  })
  .strict();
export type AssetCommitResponse = z.infer<typeof assetCommitResponseSchema>;

export const assetRestoreRequestSchema = z
  .object({ baseVersion: z.number().int().min(0) })
  .strict();
