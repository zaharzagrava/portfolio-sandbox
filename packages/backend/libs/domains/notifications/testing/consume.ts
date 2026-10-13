import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { notificationConsumers } from '../infra/consumers';
import type { NotificationConsumer } from '../infra/consumers';
import { InviteRequestedConsumer } from '../infra/invite.consumer';
import {
  familyOfType,
  type NotificationSourceFamily,
} from '../infra/notifications.topics';
import type { NotificationsTestApp } from './notifications-app';

/**
 * Delivers a batch to the consumer of its source family, exactly as the S53 runner would call `project` (the runner
 * itself needs Kafka; the e2e stack has none). Events of several families are delivered family by family, in order.
 * `family` names the consumer for a type that has no family of its own.
 */
export async function consume(
  t: NotificationsTestApp,
  events: EventEnvelope[],
  options: { family?: NotificationSourceFamily } = {},
): Promise<void> {
  const groups = new Map<NotificationSourceFamily, EventEnvelope[]>();
  for (const event of events) {
    const family = options.family ?? familyOfType(event.type);
    if (!family) throw new Error(`no consumer for ${event.type}`);
    groups.set(family, [...(groups.get(family) ?? []), event]);
  }
  for (const [family, batch] of groups) {
    const consumer = notificationConsumers
      .map((type) => t.app.get<NotificationConsumer>(type))
      .find((c) => c.family === family);
    if (!consumer) throw new Error(`no consumer for family ${family}`);
    await consumer.project(batch);
  }
}

/** Hands one message to the handler of queue `tenancy-invite-requested`, as the queue consumer does. */
export function consumeInvite(
  t: NotificationsTestApp,
  body: unknown,
  messageId = 'message-1',
): Promise<void> {
  return t.app.get(InviteRequestedConsumer).handle(messageId, body);
}
