import { Injectable } from '@nestjs/common';
import type { NotificationRealtimeEvent } from '@marketplace-sandbox/contracts';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import type { RealtimeNotifier } from '../domain/ports';
import { REALTIME_TIMEOUT_MS, withTimeout } from './with-timeout';

/**
 * `REALTIME_NOTIFIER` over S51's publisher: event `notification` on the owner-only topic `user:<userId>`. A 500 ms
 * timeout; failures propagate so the router can count `notifications_realtime_publish_failed_total` and carry on
 * (the announcement is best effort, never part of the routing outcome).
 */
@Injectable()
export class RealtimeNotifierAdapter implements RealtimeNotifier {
  constructor(private readonly publisher: RealtimePublisher) {}

  async notify(
    userId: string,
    event: NotificationRealtimeEvent,
  ): Promise<void> {
    const result = await withTimeout(
      this.publisher.publish(`user:${userId}`, 'notification', event),
      REALTIME_TIMEOUT_MS,
      'realtime publish',
    );
    if (!result.published)
      throw new Error('realtime hub did not accept the event');
  }
}
