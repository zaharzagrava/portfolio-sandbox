import { z } from "zod";

/** S24 product chat channel shapes (specs/domains/S24-product-chat/contracts/http.md). */
export const CHAT_MEMBER_ROLES = ["OWNER", "MODERATOR", "MEMBER"] as const;
export const chatMemberRoleSchema = z.enum(CHAT_MEMBER_ROLES);

const instant = z.string().min(1);

export const CHAT_TITLE_MAX = 120;
const title = z.string().min(1).max(CHAT_TITLE_MAX);

export const chatChannelSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  shopId: z.string().uuid(),
  sellerId: z.string().uuid(),
  title: z.string(),
  isArchived: z.boolean(),
  archivedAt: instant.nullable(),
  createdAt: instant,
  updatedAt: instant,
  myRole: chatMemberRoleSchema.nullable(),
});
export type ChatChannel = z.infer<typeof chatChannelSchema>;

/** `POST /chat/channels`. */
export const createChannelRequestSchema = z.strictObject({
  productId: z.string().uuid(),
  title: title.optional(),
});
export type CreateChannelRequest = z.infer<typeof createChannelRequestSchema>;

/** `PATCH /chat/channels/:channelId`: at least one field. */
export const updateChannelRequestSchema = z
  .strictObject({ title: title.optional(), isArchived: z.boolean().optional() })
  .refine((v) => v.title !== undefined || v.isArchived !== undefined, {
    message: "at least one field",
  });
export type UpdateChannelRequest = z.infer<typeof updateChannelRequestSchema>;

/** `POST /chat/channels/:channelId/members/{ban,unban,promote,demote,unmute}`. */
export const moderationRequestSchema = z.strictObject({
  userId: z.string().uuid(),
});
export const CHAT_MUTE_MAX_MINUTES = 43_200;
export const muteRequestSchema = z.strictObject({
  userId: z.string().uuid(),
  minutes: z.number().int().min(1).max(CHAT_MUTE_MAX_MINUTES),
});
