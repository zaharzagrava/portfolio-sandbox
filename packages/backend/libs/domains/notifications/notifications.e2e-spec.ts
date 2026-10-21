import { INestApplication, Injectable, Module } from '@nestjs/common';
import {
  getConnectionToken,
  getModelToken,
  SequelizeModule,
} from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import {
  markReadRequestSchema,
  notificationPageSchema,
  unreadCountSchema,
} from '@marketplace-sandbox/contracts';
import request from 'supertest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { waitFor } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { AuthApiModule, UserModel as User } from '@app/domains/identity';
import { issueSession } from '@app/test/seeds/session.fixture';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { ApiConfigService } from '@app/common/config';
import { JobsTestProbe } from '@app/infrastructure/jobs';
import { ShopMembershipModel as ShopMembership } from '@app/domains/tenancy';
import { OrderPaid } from '@app/domains/orders';
import { envelope, waitForQueueEmpty } from './testing';
import { NotificationsModule } from './notifications.module';
import { NotificationsWorkerModule } from './notifications-worker.module';
import { NotificationsCoreModule } from './notifications-core.module';
import { EventRoutingService } from './application/event-routing.service';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { EMAIL_PROVIDERS, ChannelProvider } from './domain/provider-ports';
import { LogPushProvider } from './infra/providers/log.providers';
import { PUSH_PROVIDERS } from './domain/provider-ports';
import { SnsVerifier } from './api/sns-verifier';
import { DeliveryMessage } from './domain/types';
import {
  DELIVERY_TIMELINE_STORE,
  type DeliveryTimelineStore,
} from './domain/ports';

/** Stands in for the Kafka consumer: hands a batch of order events to the routing service. */
@Injectable()
class NotificationRouterProjector {
  constructor(private readonly routing: EventRoutingService) {}
  project(events: EventEnvelope[]) {
    return this.routing.consume('orders', events);
  }
}

@Module({
  imports: [
    NotificationsCoreModule,
    SequelizeModule.forFeature([ShopMembership]),
  ],
  providers: [NotificationRouterProjector],
})
class RouterSpecModule {}

const TOPIC = 'arn:aws:sns:eu-central-1:123456789012:ses-events';

/**
 * SD-17 against real Postgres + Redis + Scylla + ElasticMQ: domain event →
 * router → inbox + SQS → channel worker → provider (spied at the SDK boundary).
 */
describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let router: NotificationRouterProjector;
  let emailSend: jest.SpyInstance;
  let push: LogPushProvider;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [
        NotificationsModule,
        NotificationsWorkerModule,
        RouterSpecModule,
        AuthApiModule,
        RateLimitModule,
        SeedsModule,
      ],
      {
        stores: ['redis', 'cassandra', 'sqs', 'dynamo'],
      },
    );
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api');
    await app.init();
    seeds = app.get(SeedsService);
    router = app.get(NotificationRouterProjector);

    const smtp = app
      .get<ChannelProvider[]>(EMAIL_PROVIDERS)
      .find((p) => p.name === 'smtp')!;
    // Spied at the SDK boundary; reports itself as SES so provider callbacks (SNS) can be exercised.
    emailSend = jest
      .spyOn(smtp, 'send')
      .mockImplementation(async (m: DeliveryMessage) => ({
        provider: 'ses',
        providerMessageId: `msg-${m.deliveryId}`,
      }));
    push = app.get<ChannelProvider[]>(PUSH_PROVIDERS)[0] as LogPushProvider;

    const config = app.get(ApiConfigService);
    const get = config.get.bind(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation(((key: string) =>
        key === 'ses_events_topic_arn'
          ? TOPIC
          : get(key as never)) as typeof config.get);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    emailSend.mockClear();
    push.sent.length = 0;
  });

  const user = async () => {
    const email = `n-${v4()}@mail.com`;
    const created = await app
      .get<typeof User>(getModelToken(User))
      .create({ email });
    const { bearer } = await issueSession(app, created);
    expect(bearer).toMatch(/^Bearer /);
    return {
      id: created.id,
      email,
      auth: { Authorization: bearer },
    };
  };

  const paid = (userId: string) => {
    const orderId = v4();
    return OrderPaid.create(orderId, 2, {
      orderId,
      userId,
      orderVersion: 2,
      totalMinor: 129_900,
      currency: 'usd',
      paymentRef: v4(),
      paidAt: new Date().toISOString(),
      lines: [
        {
          productId: v4(),
          shopId: null,
          title: 'Item',
          quantity: 1,
          unitPriceMinor: 129_900,
          discountMinor: 0,
          lineTotalMinor: 129_900,
        },
      ],
      shopOrders: [],
    });
  };

  const emailsTo = (address: string) =>
    emailSend.mock.calls
      .filter(([m]) => (m as DeliveryMessage).to.includes(address))
      .map(([m]) => m as DeliveryMessage);

  it('order paid → rendered email via the email queue + inbox item + unread badge; a replayed event sends nothing twice', async () => {
    const u = await user();
    const event = paid(u.id);
    await router.project([event]);

    const [email] = await waitFor(
      async () => emailsTo(u.email).length === 1 && emailsTo(u.email),
      { description: 'email sent' },
    );
    expect(email.subject).toBe(
      `Your order ${event.aggregateId.slice(0, 8).toUpperCase()} is confirmed`,
    );
    expect(email.html).toContain('$1,299.00');
    expect(email.unsubscribeUrl).toMatch(
      /\/api\/notifications\/unsubscribe\?token=/,
    );

    const inbox = (
      await http().get('/api/notifications').set(u.auth).expect(200)
    ).body;
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({
      type: 'order.confirmed',
      read: false,
      link: `/orders/${event.aggregateId}`,
    });
    // W03 B-5: the shapes the web reads are the contract schemas
    expect(notificationPageSchema.parse(inbox).items[0].id).toBe(
      inbox.items[0].id,
    );
    expect(
      unreadCountSchema.parse(
        (
          await http()
            .get('/api/notifications/unread-count')
            .set(u.auth)
            .expect(200)
        ).body,
      ),
    ).toEqual({ unread: 1 });
    expect(
      markReadRequestSchema.safeParse({ ids: [inbox.items[0].id] }).success,
    ).toBe(true);
    expect(markReadRequestSchema.safeParse({ all: true }).success).toBe(true);
    expect(markReadRequestSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(
      (
        await http()
          .get('/api/notifications/unread-count')
          .set(u.auth)
          .expect(200)
      ).body,
    ).toEqual({ unread: 1 });

    // Kafka redelivers the same event (projector crashed before committing the offset).
    await router.project([event]);
    await waitForQueueEmpty({ app } as never, 'notify-email');
    expect(emailsTo(u.email)).toHaveLength(1);
    expect(
      (await http().get('/api/notifications').set(u.auth).expect(200)).body
        .items,
    ).toHaveLength(1);
    expect(
      (
        await http()
          .get('/api/notifications/unread-count')
          .set(u.auth)
          .expect(200)
      ).body,
    ).toEqual({ unread: 1 });

    await http()
      .post('/api/notifications/read')
      .set(u.auth)
      .send({ ids: [inbox.items[0].id] })
      .expect(200, { unread: 0 });
    await http()
      .post('/api/notifications/read')
      .set(u.auth)
      .send({ ids: [inbox.items[0].id] })
      .expect(200, { unread: 0 }); // second tab: no negative badge
  });

  it('quiet hours delay push past the SQS limit into a scheduled job; the inbox gets it immediately', async () => {
    const u = await user();
    const now = new Date();
    const hhmm = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    const end = new Date(now.getTime() + 2 * 3_600_000);
    await http()
      .put('/api/notifications/settings')
      .set(u.auth)
      .send({
        timezone: 'UTC',
        quietStart: hhmm(new Date(now.getTime() - 3_600_000)),
        quietEnd: hhmm(end),
      })
      .expect(200);
    await http()
      .post('/api/notifications/devices')
      .set(u.auth)
      .send({ token: `tok-${v4()}`, platform: 'ios' })
      .expect(201);

    const auctionId = v4();
    await router.project([
      envelope(
        'auction.leader_changed',
        {
          auctionId,
          previousLeaderId: u.id,
          priceMinor: 50_000,
          currency: 'USD',
          auctionVersion: 7,
        },
        { aggregateId: auctionId, aggregateVersion: 7 },
      ),
    ]);

    // A hold longer than the queue delay becomes a wake-up job per delivery; the delivery itself waits as `delayed`.
    const probe = new JobsTestProbe(app.get<Sequelize>(getConnectionToken()));
    const [job] = await waitFor(
      async () => {
        const jobs = await probe.find('notifications.wake-delivery');
        return jobs.length > 0 && jobs;
      },
      { description: 'wake-up job' },
    );
    const held = await app
      .get<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE)
      .find((job.payload as { deliveryId: string }).deliveryId);
    expect(held).toMatchObject({
      userId: u.id,
      channel: 'push',
      type: 'auction.outbid',
      status: 'delayed',
    });
    expect(
      Math.abs(new Date(job.runAt).getTime() - end.getTime()),
    ).toBeLessThan(61_000);
    expect(push.sent.filter((m) => m.userId === u.id)).toHaveLength(0);
    expect(
      (await http().get('/api/notifications').set(u.auth).expect(200)).body
        .items[0],
    ).toMatchObject({
      type: 'auction.outbid',
      title: "You've been outbid",
    });
  });

  it('one-click unsubscribe stops that category by email only; GET never unsubscribes', async () => {
    const u = await user();
    await router.project([paid(u.id)]);
    const [first] = await waitFor(
      async () => emailsTo(u.email).length === 1 && emailsTo(u.email),
    );
    const path =
      new URL(first.unsubscribeUrl!).pathname +
      new URL(first.unsubscribeUrl!).search;

    await http().get(path).expect(200, { category: 'orders' }); // link scanner pre-fetch
    expect(
      (
        await http().get('/api/notifications/preferences').set(u.auth)
      ).body.preferences.find(
        (p: { category: string }) => p.category === 'orders',
      ).channels.email,
    ).toBe(true);
    await http()
      .post(path)
      .send('List-Unsubscribe=One-Click')
      .expect(200, { unsubscribed: 'orders' });
    await http()
      .post(path.replace(/token=[^&]+/, 'token=forged.token'))
      .expect(400);

    await router.project([paid(u.id)]);
    await waitFor(
      async () =>
        (await http().get('/api/notifications').set(u.auth)).body.items
          .length === 2,
    );
    await waitForQueueEmpty({ app } as never, 'notify-email');
    expect(emailsTo(u.email)).toHaveLength(1);
  });

  it('SES complaint via signed SNS → address suppressed + marketing email off; forged or foreign-topic messages rejected', async () => {
    const u = await user();
    await http()
      .put('/api/notifications/preferences')
      .set(u.auth)
      .send({ category: 'marketing', channel: 'email', enabled: true })
      .expect(200); // opted in
    await router.project([paid(u.id)]);
    const [sent] = await waitFor(
      async () => emailsTo(u.email).length === 1 && emailsTo(u.email),
    );

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    jest
      .spyOn(app.get(SnsVerifier), 'fetchCertificate')
      .mockResolvedValue(
        publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      );
    const sns = (topic: string, message: object) => {
      const m = {
        Type: 'Notification',
        MessageId: v4(),
        TopicArn: topic,
        Message: JSON.stringify(message),
        Timestamp: new Date().toISOString(),
        SignatureVersion: '2',
        SigningCertURL:
          'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-test.pem',
      };
      const canonical = [
        'Message',
        'MessageId',
        'Timestamp',
        'TopicArn',
        'Type',
      ]
        .map((k) => `${k}\n${m[k as keyof typeof m]}\n`)
        .join('');
      return {
        ...m,
        Signature: createSign('RSA-SHA256')
          .update(canonical)
          .sign(privateKey, 'base64'),
      };
    };
    const complaint = {
      eventType: 'Complaint',
      mail: { messageId: `msg-${sent.deliveryId}` },
      complaint: { complainedRecipients: [{ emailAddress: u.email }] },
    };

    const post = (body: object) =>
      http()
        .post('/api/notifications/webhooks/ses')
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify(body));

    await post(
      sns('arn:aws:sns:eu-central-1:999999999999:attacker', complaint),
    ).expect(403);
    await post({
      ...sns(TOPIC, complaint),
      Message: JSON.stringify({
        ...complaint,
        complaint: {
          complainedRecipients: [{ emailAddress: 'victim@mail.com' }],
        },
      }),
    }).expect(401);
    await post(sns(TOPIC, complaint)).expect(200);
    // The callback is queued and applied by the callback worker, so the preference turns off shortly after the 200.
    const marketingEmail = await waitFor(
      async () => {
        const prefs = (
          await http().get('/api/notifications/preferences').set(u.auth)
        ).body.preferences;
        const email = prefs.find(
          (p: { category: string }) => p.category === 'marketing',
        ).channels.email;
        return email === false ? { email } : false;
      },
      { description: 'marketing e-mail switched off' },
    );
    expect(marketingEmail.email).toBe(false);

    await router.project([paid(u.id)]);
    await waitFor(
      async () =>
        (await http().get('/api/notifications').set(u.auth)).body.items
          .length === 2,
    );
    await waitForQueueEmpty({ app } as never, 'notify-email');
    expect(emailsTo(u.email)).toHaveLength(1); // suppressed before reaching any provider
  });
});
