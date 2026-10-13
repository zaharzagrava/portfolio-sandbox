import { v4 } from 'uuid';
import {
  CATEGORIES,
  CHANNELS,
  NOTIFICATION_TYPES,
  typeDef,
  type NotificationType,
} from './domain/catalog';
import {
  DEVICE_REPOSITORY,
  FOLLOWER_AUDIENCE,
  SETTINGS_REPOSITORY,
  type DeviceRepository,
  type FollowerAudience,
  type SettingsRepository,
} from './domain/ports';
import {
  consume,
  consumeInvite,
  createNotificationsApp,
  envelope,
  orderPaidEnvelope,
  waitFor as waitForSoon,
  type NotificationsTestApp,
  type TestUser,
} from './testing';

const waitFor: typeof waitForSoon = (probe, options = {}) =>
  waitForSoon(probe, { timeoutMs: 45_000, ...options });

const CYRILLIC = /[Ѐ-ӿ]/;

/** Who is told by a row: the buyer, an owner of the shop, or an invited address. */
type To = 'buyer' | 'owner' | 'invitee';

interface World {
  buyer: TestUser;
  owner: TestUser;
  /** Receives nothing from any row. */
  bystander: TestUser;
  shopId: string;
  inviteeEmail: string;
}

interface Row {
  type: NotificationType;
  to: To;
  /** Delivers the source event(s) of the row to the consumers. */
  emit?: (t: NotificationsTestApp, w: World) => Promise<void>;
  /** Not reachable from a source event; the capability scenario that proves it end to end. */
  internal?: string;
  /** A phrase of the uk text that proves a variant was chosen. */
  ukPhrase?: RegExp;
}

const iso = () => new Date().toISOString();
const later = () => new Date(Date.now() + 3_600_000).toISOString();

const ROWS: Row[] = [
  {
    type: 'account.welcome',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('identity.user_registered', { userId: w.buyer.id }),
      ]),
  },
  {
    type: 'security.registration_attempt',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('identity.registration_duplicate_attempted', {
          userId: w.buyer.id,
        }),
      ]),
  },
  {
    type: 'security.password_changed',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('identity.password_changed', { userId: w.buyer.id }),
      ]),
  },
  {
    type: 'security.password_reset',
    to: 'buyer',
    internal: 'AS-09 (PASSWORD_RESET_MAILER port)',
  },
  {
    type: 'security.mfa_enabled',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [envelope('identity.mfa_enabled', { userId: w.buyer.id })]),
  },
  {
    type: 'security.mfa_disabled',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('identity.mfa_disabled', {
          userId: w.buyer.id,
          reason: 'user_request',
        }),
      ]),
  },
  {
    type: 'security.recovery_code_used',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('identity.mfa_recovery_code_used', {
          userId: w.buyer.id,
          remaining: 4,
        }),
      ]),
  },
  {
    type: 'security.recovery_codes_regenerated',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('identity.mfa_recovery_codes_regenerated', {
          userId: w.buyer.id,
        }),
      ]),
  },
  {
    type: 'security.sign_in_method_added',
    to: 'buyer',
    ukPhrase: /пароль видалено/i,
    emit: (t, w) =>
      consume(t, [
        envelope('identity.federated_identity_linked', {
          userId: w.buyer.id,
          provider: 'google',
          linkMethod: 'login',
          passwordInvalidated: true,
          mfaReset: false,
        }),
      ]),
  },
  {
    type: 'security.sign_in_method_removed',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('identity.federated_identity_unlinked', {
          userId: w.buyer.id,
          provider: 'google',
        }),
      ]),
  },
  {
    type: 'security.phone_verification',
    to: 'buyer',
    internal: 'AS-21 (phone verification code)',
  },
  {
    type: 'shop.invite',
    to: 'invitee',
    emit: (t, w) =>
      consumeInvite(t, {
        inviteId: v4(),
        shopId: w.shopId,
        shopName: 'Fox & Co',
        email: w.inviteeEmail,
        role: 'STAFF',
        token: 'Tok_en-1234567890',
        expiresAt: later(),
        invitedBy: w.owner.id,
      }),
  },
  {
    type: 'shop.offboarding_started',
    to: 'owner',
    emit: (t, w) =>
      consume(t, [
        envelope('tenancy.shop_offboarding_started', {
          shopId: w.shopId,
          purgeAt: later(),
          shopVersion: 2,
        }),
      ]),
  },
  {
    type: 'shop.offboarding_cancelled',
    to: 'owner',
    emit: (t, w) =>
      consume(t, [
        envelope('tenancy.shop_offboarding_cancelled', {
          shopId: w.shopId,
          shopVersion: 3,
        }),
      ]),
  },
  {
    type: 'shop.verified',
    to: 'owner',
    emit: (t, w) =>
      consume(t, [envelope('shop.verified', { shopId: w.shopId })]),
  },
  {
    type: 'shop.rejected',
    to: 'owner',
    emit: (t, w) =>
      consume(t, [
        envelope('shop.rejected', {
          shopId: w.shopId,
          reasonCode: 'documents_unclear',
        }),
      ]),
  },
  {
    type: 'shop.document_rejected',
    to: 'owner',
    emit: (t, w) =>
      consume(t, [
        envelope('shop.onboarding_document_rejected', {
          shopId: w.shopId,
          kind: 'ID',
          reason: 'blurry',
        }),
      ]),
  },
  {
    type: 'order.confirmed',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        orderPaidEnvelope({
          userId: w.buyer.id,
          shops: [{ shopId: w.shopId, subtotalMinor: 12_990 }],
        }),
      ]),
  },
  {
    type: 'shop.order_received',
    to: 'owner',
    emit: (t, w) =>
      consume(t, [
        orderPaidEnvelope({
          userId: w.buyer.id,
          shops: [{ shopId: w.shopId, subtotalMinor: 12_990 }],
        }),
      ]),
  },
  {
    type: 'order.cancelled',
    to: 'buyer',
    ukPhrase: /закінчився/,
    emit: (t, w) =>
      consume(t, [
        envelope('order.cancelled', {
          orderId: v4(),
          userId: w.buyer.id,
          orderVersion: 4,
          reason: 'out_of_stock',
          previousStatus: 'RESERVED',
        }),
      ]),
  },
  {
    type: 'order.refunded',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('order.refunded', {
          orderId: v4(),
          userId: w.buyer.id,
          orderVersion: 5,
          amountMinor: 5_000,
          currency: 'USD',
          reason: 'customer_request',
        }),
      ]),
  },
  {
    type: 'order.shipped',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('order.fulfilment_changed', {
          orderId: v4(),
          userId: w.buyer.id,
          orderVersion: 6,
          status: 'SHIPPED',
          trackingCode: 'TRK-1',
        }),
      ]),
  },
  {
    type: 'order.delivered',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('order.fulfilment_changed', {
          orderId: v4(),
          userId: w.buyer.id,
          orderVersion: 7,
          status: 'DELIVERED',
        }),
      ]),
  },
  {
    type: 'payment.failed',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('payments.payment_failed', {
          paymentId: v4(),
          orderId: v4(),
          userId: w.buyer.id,
          amountMinor: 2_500,
          currency: 'EUR',
          occurredAt: iso(),
          paymentRef: null,
          reasonCode: 'card_declined',
          paymentVersion: 2,
        }),
      ]),
  },
  {
    type: 'delivery.picked_up',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('delivery.status_changed', {
          buyerId: w.buyer.id,
          orderId: v4(),
          status: 'PICKED_UP',
          deliveryVersion: 3,
        }),
      ]),
  },
  {
    type: 'delivery.cancelled',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('delivery.status_changed', {
          buyerId: w.buyer.id,
          orderId: v4(),
          status: 'CANCELLED',
          deliveryVersion: 4,
        }),
      ]),
  },
  {
    type: 'auction.outbid',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('auction.leader_changed', {
          auctionId: v4(),
          previousLeaderId: w.buyer.id,
          leaderId: w.bystander.id,
          priceMinor: 15_000,
          currency: 'USD',
          auctionVersion: 5,
        }),
      ]),
  },
  {
    type: 'auction.won',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('auction.closed', {
          auctionId: v4(),
          shopId: w.shopId,
          winnerId: w.buyer.id,
          finalPriceMinor: 20_000,
          currency: 'USD',
          auctionVersion: 9,
        }),
      ]),
  },
  {
    type: 'auction.second_chance',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('auction.second_chance_offered', {
          auctionId: v4(),
          offeredToId: w.buyer.id,
          priceMinor: 18_000,
          currency: 'USD',
          expiresAt: later(),
          auctionVersion: 10,
        }),
      ]),
  },
  {
    type: 'auction.sold',
    to: 'owner',
    emit: (t, w) =>
      consume(t, [
        envelope('auction.sold', {
          auctionId: v4(),
          shopId: w.shopId,
          finalPriceMinor: 20_000,
          currency: 'USD',
          auctionVersion: 11,
        }),
      ]),
  },
  {
    type: 'billing.payment_failed',
    to: 'buyer',
    ukPhrase: /підтвердження/,
    emit: (t, w) =>
      consume(t, [
        envelope('billing.invoice_payment_failed', {
          subjectType: 'USER',
          subjectId: w.buyer.id,
          attempt: 2,
          nextAttemptAt: later(),
          reason: 'authentication_required',
        }),
      ]),
  },
  {
    type: 'billing.access_withdrawn',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('billing.invoice_payment_failed', {
          subjectType: 'USER',
          subjectId: w.buyer.id,
          attempt: 4,
          nextAttemptAt: null,
        }),
      ]),
  },
  {
    type: 'billing.receipt',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('billing.invoice_paid', {
          subjectType: 'USER',
          subjectId: w.buyer.id,
          totalMinor: 999,
          currency: 'USD',
        }),
      ]),
  },
  {
    type: 'payout.paid',
    to: 'owner',
    emit: (t, w) =>
      consume(t, [
        envelope('payout.paid', {
          payoutId: v4(),
          shopId: w.shopId,
          amountMinor: 50_000,
          currency: 'USD',
          payoutVersion: 2,
        }),
      ]),
  },
  {
    type: 'payout.failed',
    to: 'owner',
    emit: (t, w) =>
      consume(t, [
        envelope('payout.failed', {
          payoutId: v4(),
          shopId: w.shopId,
          amountMinor: 50_000,
          currency: 'USD',
          payoutVersion: 3,
        }),
      ]),
  },
  {
    type: 'booking.confirmed',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('launchevents.booking_confirmed', {
          userId: w.buyer.id,
          seats: 2,
          launchEventId: v4(),
        }),
      ]),
  },
  {
    type: 'chat.message',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('chat.message_escalated', {
          recipientId: w.buyer.id,
          channelId: v4(),
          channelTitle: 'Fox & Co',
          preview: 'Is it still available?',
          dedupeKey: v4(),
        }),
      ]),
  },
  {
    type: 'discussion.reply',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('discussion.comment_created', {
          postId: v4(),
          authorId: w.bystander.id,
          parentAuthorId: w.buyer.id,
          postAuthorId: w.owner.id,
          preview: 'I agree',
        }),
      ]),
  },
  {
    type: 'discussion.comment',
    to: 'owner',
    emit: (t, w) =>
      consume(t, [
        envelope('discussion.comment_created', {
          postId: v4(),
          authorId: w.bystander.id,
          parentAuthorId: null,
          postAuthorId: w.owner.id,
          preview: 'Nice post',
        }),
      ]),
  },
  {
    type: 'developers.webhook_endpoint_disabled',
    to: 'owner',
    emit: (t, w) =>
      consume(t, [
        envelope('developerplatform.webhook_endpoint_disabled', {
          endpointId: v4(),
          shopId: w.shopId,
          host: 'hooks.example.com',
          failingSince: iso(),
        }),
      ]),
  },
  {
    type: 'insights.competitor_price_drop',
    to: 'owner',
    emit: (t, w) =>
      consume(t, [
        envelope('sellerinsights.competitor_price_dropped', {
          watchId: v4(),
          shopId: w.shopId,
          productId: v4(),
          productTitle: 'Lamp',
          host: 'rival.example.com',
          competitorPriceMinor: 4_500,
          yourPriceMinor: 5_000,
          currency: 'USD',
          ownerId: w.owner.id,
        }),
      ]),
  },
  {
    type: 'marketing.followed_shop_update',
    to: 'buyer',
    emit: (t, w) =>
      consume(t, [
        envelope('feed.item_published', {
          itemId: v4(),
          authorId: w.shopId,
          kind: 'drop_announced',
          createdAt: iso(),
        }),
      ]),
  },
];

describe('Notifications: catalog completeness', () => {
  let t: NotificationsTestApp;
  /** Followers of the account that publishes in the marketing row. */
  const followers = new Map<string, string[]>();
  const audience: FollowerAudience = {
    followers: (accountId) =>
      Promise.resolve({
        userIds: followers.get(accountId) ?? [],
        nextCursor: null,
      }),
  };

  beforeAll(async () => {
    t = await createNotificationsApp({
      env: { EMAIL_PROVIDER: 'memory' },
      overrides: [{ provide: FOLLOWER_AUDIENCE, useValue: audience }],
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    followers.clear();
  });

  const port = <T>(token: symbol) => t.app.get<T>(token, { strict: false });

  async function world(): Promise<World> {
    const buyer = await t.newUser();
    const owner = await t.newUser();
    const bystander = await t.newUser();
    const { shopId } = await t.seedShop([owner.id]);
    const settings = port<SettingsRepository>(SETTINGS_REPOSITORY);
    for (const u of [buyer, owner, bystander]) {
      await settings.update(u.id, { locale: 'uk' }, t.clock.now());
      await port<DeviceRepository>(DEVICE_REPOSITORY).register(
        { userId: u.id, token: `tok-${u.id}`, platform: 'ios' },
        10,
        t.clock.now(),
      );
    }
    followers.set(shopId, [buyer.id]);
    return {
      buyer,
      owner,
      bystander,
      shopId,
      inviteeEmail: `invitee-${v4()}@example.com`,
    };
  }

  const inbox = async (user: TestUser) =>
    (await t.as(user).get('/api/notifications').expect(200)).body
      .items as Array<{
      type: string;
      title: string;
      body: string;
    }>;

  it('S28 AS-87: the table has one sample for every row of the catalog', () => {
    expect(ROWS.map((r) => r.type).sort()).toEqual(
      Object.keys(NOTIFICATION_TYPES).sort(),
    );
  });

  it('S28 AS-87: every row names one of the 13 categories and valid default channels', () => {
    expect(CATEGORIES).toHaveLength(13);
    for (const [type, def] of Object.entries(NOTIFICATION_TYPES)) {
      expect(CATEGORIES).toContain(def.category);
      expect(def.channels.length).toBeGreaterThan(0);
      for (const channel of def.channels) expect(CHANNELS).toContain(channel);
      // A mandatory type is never marketing, and never rides a marketing-only opt-in channel set.
      if ('mandatory' in def && def.mandatory)
        expect(def.priority).toBe('transactional');
      expect(type).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it.each(ROWS.filter((r) => r.emit).map((r) => [r.type, r] as const))(
    'S28 AS-87: %s reaches exactly its recipients, on its default channels, in the recipient locale',
    async (_type, row) => {
      const w = await world();
      await row.emit!(t, w);
      const def = typeDef(row.type);
      const recipient = row.to === 'owner' ? w.owner : w.buyer;
      const address = row.to === 'invitee' ? w.inviteeEmail : recipient.email;

      if (row.to !== 'invitee' && def.channels.includes('inapp')) {
        const items = (await inbox(recipient)).filter(
          (i) => i.type === row.type,
        );
        expect(items).toHaveLength(1);
        expect(items[0].title).toMatch(CYRILLIC);
        if (row.ukPhrase) expect(items[0].body).toMatch(row.ukPhrase);
      } else if (row.to !== 'invitee') {
        expect(
          (await inbox(recipient)).filter((i) => i.type === row.type),
        ).toHaveLength(0);
      }

      if (def.channels.includes('email')) {
        const [mail] = await waitFor(
          async () => {
            const calls = t.providers.email.callsTo(address);
            return calls.length >= 1 && calls;
          },
          { description: `the e-mail of ${row.type}` },
        );
        // An invited address has no account and so no locale of its own: it gets English.
        const language = row.to === 'invitee' ? /^[^Ѐ-ӿ]+$/ : CYRILLIC;
        expect(mail.subject).toMatch(language);
        expect(mail.html).toMatch(language);
        if (row.ukPhrase) expect(mail.html).toMatch(row.ukPhrase);
        // Mandatory notices carry no unsubscribe; addressed messages have no account to unsubscribe.
        const expectsLink =
          !('mandatory' in def && def.mandatory) && row.to !== 'invitee';
        expect(Boolean(mail.unsubscribeUrl)).toBe(expectsLink);
      } else {
        expect(t.providers.email.callsTo(address)).toHaveLength(0);
      }

      if (def.channels.includes('push')) {
        const token = `tok-${recipient.id}`;
        await waitFor(async () => t.providers.push.callsTo(token).length >= 1, {
          description: `the push of ${row.type}`,
        });
        expect(t.providers.push.callsTo(token)[0].title).toMatch(CYRILLIC);
      }

      // Nobody else hears about it.
      expect(
        (await inbox(w.bystander)).filter((i) => i.type === row.type),
      ).toHaveLength(0);
      expect(t.providers.email.callsTo(w.bystander.email)).toHaveLength(0);
      expect(t.providers.push.callsTo(`tok-${w.bystander.id}`)).toHaveLength(0);
      if (row.to !== 'buyer' && row.type !== 'order.confirmed')
        expect(
          (await inbox(w.buyer)).filter((i) => i.type === row.type),
        ).toHaveLength(0);
    },
  );

  it.each(ROWS.filter((r) => r.internal).map((r) => [r.type, r] as const))(
    'S28 AS-87: %s has no source event; it is proven by its own scenario',
    (_type, row) => {
      expect(row.internal).toMatch(/^AS-\d+/);
      expect(typeDef(row.type).templates.en.title).toBeTruthy();
    },
  );
});
