import type { NotificationCategory, NotificationChannel } from '@marketplace-sandbox/contracts';

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  account: 'Account',
  security: 'Security',
  shop: 'Shop',
  orders: 'Orders',
  auctions: 'Auctions',
  billing: 'Billing',
  payouts: 'Payouts',
  bookings: 'Bookings',
  chat: 'Chat',
  discussions: 'Discussions',
  developers: 'Developers',
  insights: 'Insights',
  marketing: 'Marketing',
};

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  email: 'Email',
  sms: 'Text message',
  push: 'Push',
  inapp: 'In the app',
};
