/**
 * Every notification the marketplace can send, in one typed registry: the
 * router, templates, preference UI and unsubscribe links all derive from it.
 */
export type Channel = 'email' | 'sms' | 'push' | 'inapp';
export const CHANNELS: Channel[] = ['email', 'sms', 'push', 'inapp'];

export type Category = 'orders' | 'auctions' | 'billing' | 'chat' | 'developers' | 'insights' | 'marketing';
export const CATEGORIES: Category[] = ['orders', 'auctions', 'billing', 'chat', 'developers', 'insights', 'marketing'];

/** transactional: the user is waiting for it (own queue, never quiet-hour delayed by email). marketing: capped, low priority. */
export type Priority = 'transactional' | 'marketing';

export interface Template {
  title: string;
  body: string;
  emailSubject?: string;
  emailHtml?: string;
}

export interface NotificationTypeDef {
  category: Category;
  priority: Priority;
  /** Default channels; users can switch them off per category (or on, for opt-in channels like sms). */
  channels: Channel[];
  /** Mandatory notices (e.g. failed payment) ignore category opt-outs, never suppressions. */
  mandatory?: boolean;
  link: (data: Record<string, string>) => string;
  templates: Partial<Record<string, Template>> & { en: Template };
}

export const NOTIFICATION_TYPES = {
  'order.confirmed': {
    category: 'orders',
    priority: 'transactional',
    channels: ['email', 'push', 'inapp'],
    link: (d) => `/orders/${d.orderId}`,
    templates: {
      en: {
        title: 'Order confirmed',
        body: 'We received your payment of {{total}}. Order {{orderShort}} is being prepared.',
        emailSubject: 'Your order {{orderShort}} is confirmed',
        emailHtml: '<h1>Thanks for your order!</h1><p>We received your payment of <b>{{total}}</b>.</p><p><a href="{{url}}">View order {{orderShort}}</a></p>',
      },
      uk: {
        title: 'Замовлення підтверджено',
        body: 'Ми отримали оплату {{total}}. Замовлення {{orderShort}} готується.',
        emailSubject: 'Ваше замовлення {{orderShort}} підтверджено',
        emailHtml: '<h1>Дякуємо за замовлення!</h1><p>Оплата <b>{{total}}</b> отримана.</p><p><a href="{{url}}">Переглянути {{orderShort}}</a></p>',
      },
    },
  },
  'order.cancelled': {
    category: 'orders',
    priority: 'transactional',
    channels: ['email', 'inapp'],
    link: (d) => `/orders/${d.orderId}`,
    templates: {
      en: { title: 'Order cancelled', body: 'Order {{orderShort}} was cancelled ({{reason}}).', emailSubject: 'Order {{orderShort}} cancelled' },
    },
  },
  'auction.outbid': {
    category: 'auctions',
    priority: 'transactional',
    channels: ['push', 'inapp'],
    link: (d) => `/auctions/${d.auctionId}`,
    templates: {
      en: { title: "You've been outbid", body: 'Someone bid {{price}}. Bid again before it ends.' },
      uk: { title: 'Вашу ставку перебили', body: 'Нова ставка {{price}}. Встигніть зробити свою.' },
    },
  },
  'auction.won': {
    category: 'auctions',
    priority: 'transactional',
    channels: ['email', 'push', 'inapp'],
    link: (d) => `/auctions/${d.auctionId}`,
    templates: {
      en: { title: 'You won the auction!', body: 'Winning bid: {{price}}. Complete checkout to claim it.', emailSubject: 'You won - complete your purchase' },
    },
  },
  'billing.payment_failed': {
    category: 'billing',
    priority: 'transactional',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: () => '/settings/billing',
    templates: {
      en: { title: 'Payment failed', body: 'We could not charge your card (attempt {{attempt}}). Update your payment method to keep your plan.', emailSubject: 'Action needed: payment failed' },
    },
  },
  'chat.message': {
    category: 'chat',
    priority: 'transactional',
    channels: ['push', 'email'],
    link: (d) => `/chat/${d.channelId}`,
    templates: {
      en: { title: 'New message from {{sender}}', body: '{{preview}}', emailSubject: '{{sender}} sent you a message about {{channelTitle}}' },
      uk: { title: 'Нове повідомлення від {{sender}}', body: '{{preview}}' },
    },
  },
  'webhooks.endpoint_disabled': {
    category: 'developers',
    priority: 'transactional',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: (d) => `/shops/${d.shopId}/developers/webhooks/${d.endpointId}`,
    templates: {
      en: {
        title: 'Webhook endpoint disabled',
        body: 'Deliveries to {{url}} failed for 3 days, so the endpoint was disabled. Fix it and re-enable it to resume (missed events can be replayed).',
        emailSubject: 'Action needed: webhook endpoint disabled',
      },
    },
  },
  'competitor.price_drop': {
    category: 'insights',
    priority: 'transactional',
    channels: ['email', 'inapp'],
    link: (d) => `/shops/${d.shopId}/products/${d.productId}/competitors`,
    templates: {
      en: { title: 'A competitor undercut {{product}}', body: '{{host}} now sells it for {{competitorPrice}} (yours: {{yourPrice}}).', emailSubject: 'Price alert: {{product}}' },
    },
  },
  'marketing.drop_starting': {
    category: 'marketing',
    priority: 'marketing',
    channels: ['push', 'inapp'],
    link: (d) => `/drops/${d.dropId}`,
    templates: {
      en: { title: '{{name}} drops in 10 minutes', body: 'Be ready - limited stock.' },
    },
  },
} satisfies Record<string, NotificationTypeDef>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export function typeDef(type: NotificationType): NotificationTypeDef {
  return NOTIFICATION_TYPES[type];
}

/** Channels that are off unless the user opts in (cost / intrusiveness). */
export const OPT_IN_CHANNELS: Channel[] = ['sms'];
