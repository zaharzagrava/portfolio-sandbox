import { z } from 'zod';

/** S30 `GET /videos/:id/playback` (specs/domains/S30-video/spec.md AS-31, AS-32). `expiresAt` is null for public videos. */
export const videoPlaybackSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  masterUrl: z.url(),
  posterUrl: z.url().nullable(),
  spriteUrl: z.url().nullable().optional(),
  durationSec: z.number().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  renditions: z.array(
    z.object({
      name: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  ),
  expiresAt: z.string().nullable(),
});
export type VideoPlayback = z.infer<typeof videoPlaybackSchema>;
