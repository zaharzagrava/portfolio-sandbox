import { z } from 'zod';
import { notificationItemSchema } from './http.ts';

/**
 * Event `notification` on the owner-only topic `user:<userId>` (specs/domains/S28-notifications/contracts/http.md).
 * `unread` is the item's own flag (always true on arrival). There is no `unreadCount`: the bell re-reads
 * `GET /notifications/unread-count` on focus and reconnect (W03 follow-up).
 */
export const notificationRealtimeEventSchema = notificationItemSchema
  .omit({ read: true })
  .extend({ unread: z.boolean() });
export type NotificationRealtimeEvent = z.infer<
  typeof notificationRealtimeEventSchema
>;
