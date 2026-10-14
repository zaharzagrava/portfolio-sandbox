import { z } from "zod";

export const CHAT_PRESENCE_MAX_IDS = 100;

export const presenceResponseSchema = z.record(
  z.string().uuid(),
  z.object({ online: z.boolean(), lastSeenAt: z.number().nullable() }),
);
export type PresenceResponse = z.infer<typeof presenceResponseSchema>;

/** `?userIds=<csv>`: at most 100 UUIDs; absent or empty means none (the answer is `{}`). */
export const presenceQuerySchema = z.object({
  userIds: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",") : []))
    .pipe(z.array(z.string().uuid()).max(CHAT_PRESENCE_MAX_IDS)),
});
