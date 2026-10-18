import {
  notificationPageSchema,
  unreadCountSchema,
  type NotificationItem,
} from '@marketplace-sandbox/contracts';
import type { JourneyClient } from './journey-client';
import { type Hop, staysTrue, waitForContract } from './wait-for-contract';

/** The whole inbox of `client`, newest first (follows the cursor). */
export async function inbox(client: JourneyClient): Promise<NotificationItem[]> {
  const items: NotificationItem[] = [];
  let cursor: string | undefined;
  do {
    const reply = await client.get('/api/notifications', {
      query: { limit: 50, cursor },
      schema: notificationPageSchema,
    });
    if (reply.status !== 200)
      throw new Error(
        `inbox of ${client.label}: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    items.push(...reply.body.items);
    cursor = reply.body.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

export async function itemsOf(
  client: JourneyClient,
  type: string,
): Promise<NotificationItem[]> {
  return (await inbox(client)).filter((i) => i.type === type);
}

export async function unreadCount(client: JourneyClient): Promise<number> {
  const reply = await client.get('/api/notifications/unread-count', {
    schema: unreadCountSchema,
  });
  if (reply.status !== 200)
    throw new Error(`unread-count: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body.unread;
}

/** Waits (within the hop's deadline) until `client` has at least `count` items of `type`; returns them. */
export function waitForItems(
  hop: Hop,
  client: JourneyClient,
  type: string,
  count = 1,
  where: (item: NotificationItem) => boolean = () => true,
): Promise<NotificationItem[]> {
  return waitForContract(
    hop,
    async () => {
      const found = (await itemsOf(client, type)).filter(where);
      return found.length >= count ? found : null;
    },
    `${count} x ${type} for ${client.label}`,
  );
}

/**
 * "Exactly one": the items of `type` stay exactly `count` for the whole observation window of `hop` (no duplicate arrives
 * late), counted on the stack clock's contract time.
 */
export function staysExactly(
  hop: Hop,
  client: JourneyClient,
  type: string,
  count: number,
  where: (item: NotificationItem) => boolean = () => true,
): Promise<void> {
  return staysTrue(
    hop,
    async () => {
      const found = (await itemsOf(client, type)).filter(where);
      if (found.length !== count)
        throw new Error(
          `${client.label} has ${found.length} x ${type}, expected ${count}`,
        );
    },
    `${client.label} keeps exactly ${count} x ${type}`,
  );
}
