import { Module } from '@nestjs/common';
import { NotificationsCoreModule } from './notifications-core.module';
import { notificationConsumers } from './infra/consumers';
import { InviteRequestedConsumer } from './infra/invite.consumer';

/**
 * Event and queue consumers of notifications (apps/projector): one consumer per source family of
 * specs/domains/S28-notifications/contracts/events.md, and the consumer of queue `tenancy-invite-requested`.
 * `apps/projector` starts the families through `ProjectionsModule.forProjectors(NotificationsProjectorModule.projectors,
 * [NotificationsProjectorModule])` (T080 switches it over from the previous router projector). `ProjectionsModule` builds the consumer classes itself, so the
 * core module they inject from is re-exported; without it the monolith does not boot (UnknownDependenciesException).
 */
@Module({
  imports: [NotificationsCoreModule],
  providers: [...notificationConsumers, InviteRequestedConsumer],
  exports: [NotificationsCoreModule],
})
export class NotificationsProjectorModule {
  static readonly projectors = notificationConsumers;
}
