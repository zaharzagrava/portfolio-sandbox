import { z } from 'zod';

/** Maximum forward step of the controllable clock: one year in seconds. */
export const CLOCK_MAX_ADVANCE_SECONDS = 31_536_000;

export const clockViewSchema = z.object({
  now: z.iso.datetime(),
  mode: z.enum(['real', 'offset']),
  offsetSeconds: z.number().int().min(0),
});

export const clockUpdateSchema = z.union([
  z.object({ advanceSeconds: z.number().int().min(1).max(CLOCK_MAX_ADVANCE_SECONDS) }).strict(),
  z.object({ mode: z.literal('real') }).strict(),
]);

export type ClockView = z.infer<typeof clockViewSchema>;
export type ClockUpdate = z.infer<typeof clockUpdateSchema>;
