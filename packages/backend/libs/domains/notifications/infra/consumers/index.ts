import type { Type } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { NotificationSourceFamily } from '../notifications.topics';
import { NotificationConsumer } from './notification-consumer';

export { NotificationConsumer } from './notification-consumer';

/* One class per source family: S53 starts consumers by class, and each keeps its own group, offsets and dead letters. */
@Injectable()
export class IdentityNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'identity';
}
@Injectable()
export class TenancyNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'tenancy';
}
@Injectable()
export class ShopOnboardingNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'shopOnboarding';
}
@Injectable()
export class OrdersNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'orders';
}
@Injectable()
export class PaymentsNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'payments';
}
@Injectable()
export class DeliveryNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'delivery';
}
@Injectable()
export class AuctionsNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'auctions';
}
@Injectable()
export class BillingNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'billing';
}
@Injectable()
export class PayoutsNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'payouts';
}
@Injectable()
export class LaunchEventsNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'launchEvents';
}
@Injectable()
export class ChatNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'chat';
}
@Injectable()
export class DiscussionsNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'discussions';
}
@Injectable()
export class SellerInsightsNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'sellerInsights';
}
@Injectable()
export class DeveloperPlatformNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'developerPlatform';
}
@Injectable()
export class FeedNotificationConsumer extends NotificationConsumer {
  readonly family: NotificationSourceFamily = 'feed';
}

/** Every consumer, in the order of contracts/events.md; `NotificationsProjectorModule` provides them and `apps/projector` starts them. */
export const notificationConsumers: Type<NotificationConsumer>[] = [
  IdentityNotificationConsumer,
  TenancyNotificationConsumer,
  ShopOnboardingNotificationConsumer,
  OrdersNotificationConsumer,
  PaymentsNotificationConsumer,
  DeliveryNotificationConsumer,
  AuctionsNotificationConsumer,
  BillingNotificationConsumer,
  PayoutsNotificationConsumer,
  LaunchEventsNotificationConsumer,
  ChatNotificationConsumer,
  DiscussionsNotificationConsumer,
  SellerInsightsNotificationConsumer,
  DeveloperPlatformNotificationConsumer,
  FeedNotificationConsumer,
];
