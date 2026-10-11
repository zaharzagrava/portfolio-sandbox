import { z } from 'zod';

/** In-app inbox contracts, read from `InboxService` and `NotificationsController`. */
export const notificationItemSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  category: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  read: z.boolean(),
  createdAt: z.string().optional(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const notificationPageSchema = z.object({
  items: z.array(notificationItemSchema),
  nextCursor: z.string().nullable(),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const unreadCountSchema = z.object({
  unread: z.number().int().nonnegative(),
});
export type UnreadCount = z.infer<typeof unreadCountSchema>;

export const markReadRequestSchema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;
