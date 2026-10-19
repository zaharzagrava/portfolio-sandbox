/**
 * Every notification the marketplace can send, in one typed registry: the router, templates, preference UI and
 * unsubscribe links all derive from it (specs/domains/S28-notifications/spec.md "Notification catalog"). Adding a type
 * is a row here plus its templates.
 */
export type Channel = 'email' | 'sms' | 'push' | 'inapp';
export const CHANNELS: Channel[] = ['email', 'sms', 'push', 'inapp'];

export type Category =
  | 'account'
  | 'security'
  | 'shop'
  | 'orders'
  | 'auctions'
  | 'billing'
  | 'payouts'
  | 'bookings'
  | 'chat'
  | 'discussions'
  | 'developers'
  | 'insights'
  | 'marketing';
export const CATEGORIES: Category[] = [
  'account',
  'security',
  'shop',
  'orders',
  'auctions',
  'billing',
  'payouts',
  'bookings',
  'chat',
  'discussions',
  'developers',
  'insights',
  'marketing',
];

/** transactional: the user is waiting for it (own queue, never quiet-hour delayed by email). marketing: capped, low priority. */
export type Priority = 'transactional' | 'marketing';

/** Who a type is for, before expansion: the id in the event, the OWNER members of a shop, a bare address, or followers. */
export type RecipientKind = 'user' | 'shopOwners' | 'address' | 'followers';

export interface Template {
  title: string;
  body: string;
  emailSubject?: string;
  emailHtml?: string;
}

/**
 * After this long (from the event time) an external delivery is moot and is not sent; the inbox item stays. `until`
 * names the data field that holds the instant after which the notice is moot.
 */
export type MaxAge = { ms: number } | { until: string };

export interface NotificationTypeDef {
  category: Category;
  priority: Priority;
  recipient: RecipientKind;
  /** Default channels; users can switch them off per category (or on, for opt-in channels like sms). `inapp` = has an inbox item. */
  channels: Channel[];
  /** Mandatory notices (e.g. failed payment) ignore category opt-outs and quiet hours, never suppressions. */
  mandatory?: boolean;
  /** Defaults to 24 hours. */
  maxAge?: MaxAge;
  link: (data: Record<string, string>) => string;
  /** English lives here; other languages live in `catalog-uk.ts` (one exhaustive table per language). */
  templates: { en: Template };
  /**
   * Picks a variant of the text from the event data (a removed password, a bank asking for confirmation, the reason an
   * order was cancelled); `null` = the base template. Templates stay logic-less data: each variant is a whole template
   * per language, so a translator never edits code.
   */
  variant?: (data: Record<string, string>) => string | null;
  variants?: Record<string, { en: Template; uk: Template }>;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
export const DEFAULT_MAX_AGE_MS = 24 * HOUR;

export const NOTIFICATION_TYPES = {
  // ---- account and security (identity) -----------------------------------------------------------------------------
  'account.welcome': {
    category: 'account',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    link: () => '/',
    templates: {
      en: {
        title: 'Welcome aboard',
        body: 'Your account is ready. Browse shops and drops whenever you like.',
        emailSubject: 'Welcome to the marketplace',
      },
    },
  },
  'security.registration_attempt': {
    category: 'security',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email'],
    mandatory: true,
    link: () => '/settings/security',
    templates: {
      en: {
        title: 'Someone tried to register with your e-mail',
        body: 'If it was you, sign in instead. If not, no action is needed: your account is safe.',
        emailSubject: 'Someone tried to register with your e-mail',
      },
    },
  },
  'security.password_changed': {
    category: 'security',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: () => '/settings/security',
    templates: {
      en: {
        title: 'Your password was changed',
        body: 'If this was not you, reset your password now and contact support.',
        emailSubject: 'Your password was changed',
      },
    },
  },
  'security.password_reset': {
    category: 'security',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email'],
    mandatory: true,
    maxAge: { ms: 30 * MIN },
    // The token travels in the fragment, so it reaches no server log or Referer.
    link: (d) => `/reset-password#token=${d.token}`,
    templates: {
      en: {
        title: 'Reset your password',
        body: 'Use this link to choose a new password: {{url}}\nIt works once and expires in about {{minutes}} minutes. If you did not ask for it, ignore this message.',
        emailSubject: 'Reset your password',
        emailHtml:
          '<p>Use this link to choose a new password:</p><p><a href="{{url}}">Reset password</a></p><p>It works once and expires in about {{minutes}} minutes. If you did not ask for it, ignore this message.</p>',
      },
    },
  },
  'security.mfa_enabled': {
    category: 'security',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: () => '/settings/security',
    templates: {
      en: {
        title: 'Two-step sign-in is on',
        body: 'Two-step verification was turned on for your account.',
        emailSubject: 'Two-step sign-in is on',
      },
    },
  },
  'security.mfa_disabled': {
    category: 'security',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: () => '/settings/security',
    templates: {
      en: {
        title: 'Two-step sign-in is off',
        body: 'Two-step verification was turned off for your account ({{reason}}). If this was not you, secure your account now.',
        emailSubject: 'Two-step sign-in is off',
      },
    },
  },
  'security.recovery_code_used': {
    category: 'security',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: () => '/settings/security',
    templates: {
      en: {
        title: 'A recovery code was used',
        body: 'A recovery code signed in to your account. {{remaining}} codes are left.',
        emailSubject: 'A recovery code was used',
      },
    },
  },
  'security.recovery_codes_regenerated': {
    category: 'security',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: () => '/settings/security',
    templates: {
      en: {
        title: 'New recovery codes were issued',
        body: 'Your previous recovery codes no longer work.',
        emailSubject: 'New recovery codes were issued',
      },
    },
  },
  'security.sign_in_method_added': {
    category: 'security',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: () => '/settings/security',
    // A linked provider can take the password away and reset two-step sign-in; the text says so (S02 follow-up).
    variant: (d) => {
      const password = d.passwordInvalidated === 'true';
      const mfa = d.mfaReset === 'true';
      if (password && mfa) return 'password_removed_mfa_reset';
      if (password) return 'password_removed';
      if (mfa) return 'mfa_reset';
      return null;
    },
    templates: {
      en: {
        title: 'A sign-in method was added',
        body: '{{provider}} was linked to your account.',
        emailSubject: 'A sign-in method was added',
      },
    },
    variants: {
      password_removed: {
        en: {
          title: 'A sign-in method was added and your password was removed',
          body: '{{provider}} was linked to your account. Your password was removed: sign in with {{provider}} or set a new password.',
          emailSubject: 'Your password was removed',
        },
        uk: {
          title: 'Додано спосіб входу, а ваш пароль видалено',
          body: '{{provider}} підключено до вашого облікового запису. Пароль видалено: входьте через {{provider}} або задайте новий пароль.',
          emailSubject: 'Ваш пароль видалено',
        },
      },
      mfa_reset: {
        en: {
          title: 'A sign-in method was added and two-step sign-in was reset',
          body: '{{provider}} was linked to your account. Two-step verification was reset: set it up again in your security settings.',
          emailSubject: 'Two-step sign-in was reset',
        },
        uk: {
          title: 'Додано спосіб входу, а двоетапну перевірку скинуто',
          body: '{{provider}} підключено до вашого облікового запису. Двоетапну перевірку скинуто: налаштуйте її знову в налаштуваннях безпеки.',
          emailSubject: 'Двоетапну перевірку скинуто',
        },
      },
      password_removed_mfa_reset: {
        en: {
          title: 'Your password was removed and two-step sign-in was reset',
          body: '{{provider}} was linked to your account. Your password was removed and two-step verification was reset: sign in with {{provider}} and set both up again.',
          emailSubject: 'Your password was removed',
        },
        uk: {
          title: 'Пароль видалено, а двоетапну перевірку скинуто',
          body: '{{provider}} підключено до вашого облікового запису. Пароль видалено, двоетапну перевірку скинуто: увійдіть через {{provider}} і налаштуйте їх знову.',
          emailSubject: 'Ваш пароль видалено',
        },
      },
    },
  },
  'security.sign_in_method_removed': {
    category: 'security',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: () => '/settings/security',
    templates: {
      en: {
        title: 'A sign-in method was removed',
        body: '{{provider}} was unlinked from your account.',
        emailSubject: 'A sign-in method was removed',
      },
    },
  },
  'security.phone_verification': {
    category: 'security',
    priority: 'transactional',
    recipient: 'user',
    channels: ['sms'],
    mandatory: true,
    maxAge: { ms: 10 * MIN },
    link: () => '/settings/notifications',
    templates: {
      en: {
        title: 'Your verification code',
        body: 'Your verification code is {{code}}. It expires in 10 minutes.',
      },
    },
  },

  // ---- shops (tenancy, onboarding) ---------------------------------------------------------------------------------
  'shop.invite': {
    category: 'shop',
    priority: 'transactional',
    recipient: 'address',
    channels: ['email'],
    mandatory: true,
    link: (d) => `/invites/${d.token}`,
    templates: {
      en: {
        title: 'You are invited to {{shopName}}',
        body: 'You were invited to join {{shopName}} as {{role}}: {{url}}',
        emailSubject: 'You are invited to join {{shopName}}',
        emailHtml:
          '<p>You were invited to join <b>{{shopName}}</b> as {{role}}.</p><p><a href="{{url}}">Accept the invitation</a></p>',
      },
    },
  },
  'shop.offboarding_started': {
    category: 'shop',
    priority: 'transactional',
    recipient: 'shopOwners',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: (d) => `/shops/${d.shopId}/settings`,
    templates: {
      en: {
        title: 'Your shop is being closed',
        body: 'The shop will be deleted on {{purgeAt}}. You can cancel before then.',
        emailSubject: 'Your shop is being closed',
      },
    },
  },
  'shop.offboarding_cancelled': {
    category: 'shop',
    priority: 'transactional',
    recipient: 'shopOwners',
    channels: ['email', 'inapp'],
    link: (d) => `/shops/${d.shopId}/settings`,
    templates: {
      en: {
        title: 'Shop closure cancelled',
        body: 'Your shop stays open.',
        emailSubject: 'Shop closure cancelled',
      },
    },
  },
  'shop.verified': {
    category: 'shop',
    priority: 'transactional',
    recipient: 'shopOwners',
    channels: ['email', 'inapp'],
    link: (d) => `/shops/${d.shopId}/onboarding`,
    templates: {
      en: {
        title: 'Your shop is verified',
        body: 'You can now sell and receive payouts.',
        emailSubject: 'Your shop is verified',
      },
    },
  },
  'shop.rejected': {
    category: 'shop',
    priority: 'transactional',
    recipient: 'shopOwners',
    channels: ['email', 'inapp'],
    link: (d) => `/shops/${d.shopId}/onboarding`,
    templates: {
      en: {
        title: 'Your shop application was rejected',
        body: 'Reason: {{reasonCode}}. Review the details and apply again.',
        emailSubject: 'Your shop application was rejected',
      },
    },
  },
  'shop.document_rejected': {
    category: 'shop',
    priority: 'transactional',
    recipient: 'shopOwners',
    channels: ['email', 'inapp'],
    link: (d) => `/shops/${d.shopId}/onboarding`,
    templates: {
      en: {
        title: 'A document was rejected',
        body: 'Your {{kind}} was rejected: {{reason}}. Upload it again.',
        emailSubject: 'A document was rejected',
      },
    },
  },
  'shop.order_received': {
    category: 'shop',
    priority: 'transactional',
    recipient: 'shopOwners',
    channels: ['push', 'inapp'],
    link: (d) => `/shops/${d.shopId}/orders/${d.orderId}`,
    templates: {
      en: {
        title: 'New order',
        body: 'You received an order worth {{subtotal}}.',
      },
    },
  },

  'shop.flash_sale_sold_out': {
    category: 'shop',
    priority: 'transactional',
    recipient: 'shopOwners',
    channels: ['push', 'inapp'],
    link: (d) => `/shops/${d.shopId}/flash-sales/${d.saleId}`,
    templates: {
      en: {
        title: 'Your drop sold out',
        body: 'Every unit of your limited drop is sold.',
      },
    },
  },
  'shop.flash_sale_start_failed': {
    category: 'shop',
    priority: 'transactional',
    recipient: 'shopOwners',
    channels: ['email', 'inapp'],
    link: (d) => `/shops/${d.shopId}/flash-sales/${d.saleId}`,
    templates: {
      en: {
        title: 'Your drop could not start',
        body: 'The drop did not start ({{reason}}). Nothing was sold from it; check the stock and schedule it again.',
        emailSubject: 'Your drop could not start',
      },
    },
  },

  // ---- orders, payments, delivery ----------------------------------------------------------------------------------
  'order.confirmed': {
    category: 'orders',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'push', 'inapp'],
    link: (d) => `/orders/${d.orderId}`,
    templates: {
      en: {
        title: 'Order confirmed',
        body: 'We received your payment of {{total}}. Order {{orderShort}} is being prepared.',
        emailSubject: 'Your order {{orderShort}} is confirmed',
        emailHtml:
          '<h1>Thanks for your order!</h1><p>We received your payment of <b>{{total}}</b>.</p><p><a href="{{url}}">View order {{orderShort}}</a></p>',
      },
    },
  },
  'order.cancelled': {
    category: 'orders',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    link: (d) => `/orders/${d.orderId}`,
    // The reason is shown as a phrase in the recipient's language, never as its code.
    variant: (d) => d.reason ?? null,
    templates: {
      en: {
        title: 'Order cancelled',
        body: 'Order {{orderShort}} was cancelled.',
        emailSubject: 'Order {{orderShort}} cancelled',
      },
    },
    variants: {
      out_of_stock: {
        en: {
          title: 'Order cancelled',
          body: 'Order {{orderShort}} was cancelled because an item went out of stock.',
          emailSubject: 'Order {{orderShort}} cancelled',
        },
        uk: {
          title: 'Замовлення скасовано',
          body: 'Замовлення {{orderShort}} скасовано, бо товар закінчився.',
          emailSubject: 'Замовлення {{orderShort}} скасовано',
        },
      },
      hold_expired: {
        en: {
          title: 'Order cancelled',
          body: 'Order {{orderShort}} was cancelled because the time to pay ran out.',
          emailSubject: 'Order {{orderShort}} cancelled',
        },
        uk: {
          title: 'Замовлення скасовано',
          body: 'Замовлення {{orderShort}} скасовано, бо час на оплату минув.',
          emailSubject: 'Замовлення {{orderShort}} скасовано',
        },
      },
    },
  },
  'order.refunded': {
    category: 'orders',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    link: (d) => `/orders/${d.orderId}`,
    templates: {
      en: {
        title: 'Refund issued',
        body: 'We refunded {{amount}} for order {{orderShort}}.',
        emailSubject: 'Refund for order {{orderShort}}',
      },
    },
  },
  'order.shipped': {
    category: 'orders',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'push', 'inapp'],
    link: (d) => `/orders/${d.orderId}`,
    templates: {
      en: {
        title: 'Your order is on its way',
        body: 'Order {{orderShort}} was shipped. Tracking: {{trackingCode}}',
        emailSubject: 'Order {{orderShort}} was shipped',
      },
    },
  },
  'order.delivered': {
    category: 'orders',
    priority: 'transactional',
    recipient: 'user',
    channels: ['push', 'inapp'],
    link: (d) => `/orders/${d.orderId}`,
    templates: {
      en: {
        title: 'Order delivered',
        body: 'Order {{orderShort}} was delivered.',
      },
    },
  },
  'payment.failed': {
    category: 'orders',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'push', 'inapp'],
    link: (d) => `/orders/${d.orderId}`,
    templates: {
      en: {
        title: 'Payment failed',
        body: 'Your payment of {{amount}} for order {{orderShort}} did not go through. Try another payment method.',
        emailSubject: 'Payment failed for order {{orderShort}}',
      },
    },
  },
  'delivery.picked_up': {
    category: 'orders',
    priority: 'transactional',
    recipient: 'user',
    channels: ['push', 'inapp'],
    link: (d) => `/orders/${d.orderId}`,
    templates: {
      en: {
        title: 'Out for delivery',
        body: 'The courier picked up order {{orderShort}}.',
      },
    },
  },
  'delivery.cancelled': {
    category: 'orders',
    priority: 'transactional',
    recipient: 'user',
    channels: ['push', 'inapp'],
    link: (d) => `/orders/${d.orderId}`,
    templates: {
      en: {
        title: 'Delivery cancelled',
        body: 'The delivery of order {{orderShort}} was cancelled.',
      },
    },
  },

  // ---- auctions ----------------------------------------------------------------------------------------------------
  'auction.outbid': {
    category: 'auctions',
    priority: 'transactional',
    recipient: 'user',
    channels: ['push', 'inapp'],
    maxAge: { ms: HOUR },
    link: (d) => `/auctions/${d.auctionId}`,
    templates: {
      en: {
        title: "You've been outbid",
        body: 'Someone bid {{price}}. Bid again before it ends.',
      },
    },
  },
  'auction.won': {
    category: 'auctions',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'push', 'inapp'],
    link: (d) => `/auctions/${d.auctionId}`,
    templates: {
      en: {
        title: 'You won the auction!',
        body: 'Winning bid: {{price}}. Complete checkout to claim it.',
        emailSubject: 'You won - complete your purchase',
      },
    },
  },
  'auction.second_chance': {
    category: 'auctions',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'push', 'inapp'],
    maxAge: { until: 'expiresAt' },
    link: (d) => `/auctions/${d.auctionId}`,
    templates: {
      en: {
        title: 'A second chance',
        body: 'The winner did not pay. You can still buy it for {{price}} until {{expiresAt}}.',
        emailSubject: 'A second chance to buy',
      },
    },
  },
  'auction.sold': {
    category: 'auctions',
    priority: 'transactional',
    recipient: 'shopOwners',
    channels: ['email', 'inapp'],
    link: (d) => `/shops/${d.shopId}/auctions/${d.auctionId}`,
    templates: {
      en: {
        title: 'Auction sold',
        body: 'Your auction sold for {{price}}.',
        emailSubject: 'Your auction sold',
      },
    },
  },

  // ---- billing, payouts, bookings ----------------------------------------------------------------------------------
  'billing.payment_failed': {
    category: 'billing',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: () => '/settings/billing',
    variant: (d) => (d.reason === 'authentication_required' ? d.reason : null),
    templates: {
      en: {
        title: 'Payment failed',
        body: 'We could not charge your card (attempt {{attempt}}). Update your payment method to keep your plan.',
        emailSubject: 'Action needed: payment failed',
      },
    },
    variants: {
      authentication_required: {
        en: {
          title: 'Your bank needs you to confirm the payment',
          body: 'Your bank asked for extra confirmation, so the charge did not go through (attempt {{attempt}}). Confirm it in your billing settings to keep your plan.',
          emailSubject: 'Action needed: confirm your payment',
        },
        uk: {
          title: 'Банк просить підтвердити платіж',
          body: 'Банк вимагає додаткового підтвердження, тому платіж не пройшов (спроба {{attempt}}). Підтвердьте його в налаштуваннях оплати, щоб зберегти план.',
          emailSubject: 'Потрібна дія: підтвердьте платіж',
        },
      },
    },
  },
  'billing.access_withdrawn': {
    category: 'billing',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: () => '/settings/billing',
    templates: {
      en: {
        title: 'Your plan access was withdrawn',
        body: 'We could not collect payment after {{attempt}} attempts, so paid features are off. Update your payment method to restore them.',
        emailSubject: 'Your plan access was withdrawn',
      },
    },
  },
  'billing.receipt': {
    category: 'billing',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    link: () => '/settings/billing',
    templates: {
      en: {
        title: 'Payment received',
        body: 'We received {{total}}. Thank you.',
        emailSubject: 'Your receipt',
      },
    },
  },
  'payout.paid': {
    category: 'payouts',
    priority: 'transactional',
    recipient: 'shopOwners',
    channels: ['email', 'inapp'],
    link: (d) => `/shops/${d.shopId}/payouts`,
    templates: {
      en: {
        title: 'Payout sent',
        body: 'A payout of {{amount}} was sent to your bank account.',
        emailSubject: 'Payout sent',
      },
    },
  },
  'payout.failed': {
    category: 'payouts',
    priority: 'transactional',
    recipient: 'shopOwners',
    channels: ['email', 'inapp'],
    link: (d) => `/shops/${d.shopId}/payouts`,
    templates: {
      en: {
        title: 'Payout failed',
        body: 'A payout of {{amount}} failed. Check your bank details.',
        emailSubject: 'Payout failed',
      },
    },
  },
  'booking.confirmed': {
    category: 'bookings',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'push', 'inapp'],
    link: (d) => `/events/${d.launchEventId}`,
    templates: {
      en: {
        title: 'Booking confirmed',
        body: 'Your booking for {{seats}} seat(s) is confirmed.',
        emailSubject: 'Booking confirmed',
      },
    },
  },

  // ---- chat, discussions, developers, insights ---------------------------------------------------------------------
  'chat.message': {
    category: 'chat',
    priority: 'transactional',
    recipient: 'user',
    channels: ['push', 'inapp'],
    maxAge: { ms: HOUR },
    link: (d) => `/chat/${d.channelId}`,
    templates: {
      en: {
        title: 'New message in {{channelTitle}}',
        body: '{{preview}}',
        emailSubject: 'New message in {{channelTitle}}',
      },
    },
  },
  'discussion.reply': {
    category: 'discussions',
    priority: 'transactional',
    recipient: 'user',
    channels: ['push', 'inapp'],
    link: (d) => `/discussions/${d.postId}`,
    templates: {
      en: { title: 'New reply to your comment', body: '{{preview}}' },
    },
  },
  'discussion.comment': {
    category: 'discussions',
    priority: 'transactional',
    recipient: 'user',
    channels: ['inapp'],
    link: (d) => `/discussions/${d.postId}`,
    templates: {
      en: { title: 'New comment on your post', body: '{{preview}}' },
    },
  },
  'developers.webhook_endpoint_disabled': {
    category: 'developers',
    priority: 'transactional',
    recipient: 'shopOwners',
    channels: ['email', 'inapp'],
    mandatory: true,
    link: (d) => `/shops/${d.shopId}/developers/webhooks/${d.endpointId}`,
    templates: {
      en: {
        title: 'Webhook endpoint disabled',
        body: 'Deliveries to {{host}} failed since {{failingSince}}, so the endpoint was disabled. Fix it and re-enable it to resume (missed events can be replayed).',
        emailSubject: 'Action needed: webhook endpoint disabled',
      },
    },
  },
  'insights.competitor_price_drop': {
    category: 'insights',
    priority: 'transactional',
    recipient: 'user',
    channels: ['email', 'inapp'],
    link: (d) => `/shops/${d.shopId}/products/${d.productId}/competitors`,
    templates: {
      en: {
        title: 'A competitor undercut {{product}}',
        body: '{{host}} now sells it for {{competitorPrice}} (yours: {{yourPrice}}).',
        emailSubject: 'Price alert: {{product}}',
      },
    },
  },

  // ---- marketing ---------------------------------------------------------------------------------------------------
  'marketing.followed_shop_update': {
    category: 'marketing',
    priority: 'marketing',
    recipient: 'followers',
    channels: ['inapp'],
    maxAge: { ms: HOUR },
    link: (d) => `/feed/${d.itemId}`,
    templates: {
      en: {
        title: 'News from a shop you follow',
        body: 'A shop you follow published something new.',
      },
    },
  },
} satisfies Record<string, NotificationTypeDef>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export function typeDef(type: NotificationType): NotificationTypeDef {
  return NOTIFICATION_TYPES[type];
}

/**
 * The instant after which an external delivery of `type` is moot: the event time plus the type's maximum age, or the
 * instant the data names. Pure: `occurredAt` and the data come from the request.
 */
export function staleAfter(
  type: NotificationType,
  occurredAt: Date,
  data: Record<string, string>,
): Date {
  const maxAge = typeDef(type).maxAge;
  if (maxAge && 'until' in maxAge) {
    const until = Date.parse(data[maxAge.until] ?? '');
    if (!Number.isNaN(until)) return new Date(until);
  }
  const ms = maxAge && 'ms' in maxAge ? maxAge.ms : DEFAULT_MAX_AGE_MS;
  return new Date(occurredAt.getTime() + ms);
}

/** Channels that are off unless the user opts in (cost / intrusiveness). */
export const OPT_IN_CHANNELS: Channel[] = ['sms'];
