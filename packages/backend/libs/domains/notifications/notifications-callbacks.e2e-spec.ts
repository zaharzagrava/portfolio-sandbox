import { createSign, generateKeyPairSync } from 'node:crypto';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { v4 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { SnsVerifier, twilioSignature } from './api/sns-verifier';
import { CallbackWorkerService } from './application/callback-worker.service';
import { DeliveryWorkerService } from './application/delivery-worker.service';
import { SuppressionService } from './application/suppression.service';
import {
  DELIVERY_TIMELINE_STORE,
  type DeliveryTimelineStore,
} from './domain/ports';
import type { DeliveryMessage, DeliveryStatus } from './domain/types';
import { CALLBACK_QUEUE_NAME } from './infra/notifications.topics';
import {
  createNotificationsApp,
  inParallel,
  purgeDeliveryLines,
  queueDepth,
  waitFor as waitForSoon,
  waitForQueueEmpty,
  type NotificationsTestApp,
  type TestUser,
} from './testing';

/** Callback workers and a redelivery after a failed apply take a visibility timeout; allow for it. */
const waitFor: typeof waitForSoon = (probe, options = {}) =>
  waitForSoon(probe, { timeoutMs: 45_000, ...options });

const TOPIC = 'arn:aws:sns:eu-central-1:123456789012:ses-events';
const CERT_URL =
  'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-test.pem';
const TWILIO_TOKEN = 'twilio-test-token';
const MINUTE = 60_000;

const SIGNED_FIELDS = {
  Notification: [
    'Message',
    'MessageId',
    'Subject',
    'Timestamp',
    'TopicArn',
    'Type',
  ],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
} as const;

describe('Notifications: provider callbacks and suppression', () => {
  let t: NotificationsTestApp;
  // One key pair for the file: the verifier caches the signing certificate by URL, as it does in production.
  const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const service = <T>(type: abstract new (...args: never[]) => T) =>
    t.app.get<T>(type, { strict: false });
  const timeline = () =>
    t.app.get<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE, {
      strict: false,
    });
  const metric = (name: string, labels: Record<string, string> = {}) =>
    MetricsRegistry.value(name, labels) ?? 0;
  const callbacks = (provider: string, outcome: string) =>
    metric('notifications_callbacks_total', { provider, outcome });
  const dropped = () =>
    metric('notifications_callbacks_dropped_total', {
      reason: 'unknown_message',
    });

  beforeAll(async () => {
    t = await createNotificationsApp({
      env: {
        EMAIL_PROVIDER: 'memory',
        SES_EVENTS_TOPIC_ARN: TOPIC,
        TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
      },
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await t.reset();
    await purgeDeliveryLines(t);
    jest
      .spyOn(service(SnsVerifier), 'fetchCertificate')
      .mockImplementation(() =>
        Promise.resolve(
          signing.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        ),
      );
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---- helpers -------------------------------------------------------------------------------------------------------

  type SnsOverrides = Partial<{
    topic: string;
    messageId: string;
    timestamp: Date;
    certUrl: string;
    privateKey: typeof signing.privateKey;
  }>;

  /** A correctly signed SNS delivery of `inner` (a string is sent as is; an object is JSON). */
  function sns(
    inner: object | string,
    o: SnsOverrides = {},
    type: 'Notification' | 'SubscriptionConfirmation' = 'Notification',
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const m: Record<string, string> = {
      Type: type,
      MessageId: o.messageId ?? v4(),
      TopicArn: o.topic ?? TOPIC,
      Message: typeof inner === 'string' ? inner : JSON.stringify(inner),
      Timestamp: (o.timestamp ?? t.clock.now()).toISOString(),
      SignatureVersion: '2',
      SigningCertURL: o.certUrl ?? CERT_URL,
      ...extra,
    };
    const canonical = SIGNED_FIELDS[type]
      .filter((f) => m[f] !== undefined)
      .map((f) => `${f}\n${m[f]}\n`)
      .join('');
    return {
      ...m,
      Signature: createSign('RSA-SHA256')
        .update(canonical)
        .sign(o.privateKey ?? signing.privateKey, 'base64'),
    };
  }

  const postSes = (body: object | string) =>
    t
      .http()
      .post('/api/notifications/webhooks/ses')
      .set('Content-Type', 'text/plain')
      .send(typeof body === 'string' ? body : JSON.stringify(body));

  const complaint = (messageId: string, ...addresses: string[]) => ({
    eventType: 'Complaint',
    mail: { messageId },
    complaint: {
      complainedRecipients: addresses.map((emailAddress) => ({
        emailAddress,
      })),
    },
  });
  const bounce = (
    messageId: string,
    bounceType: 'Permanent' | 'Transient',
    address: string,
  ) => ({
    eventType: 'Bounce',
    mail: { messageId },
    bounce: { bounceType, bouncedRecipients: [{ emailAddress: address }] },
  });
  const delivery = (messageId: string) => ({
    eventType: 'Delivery',
    mail: { messageId },
  });

  /** A delivery the provider accepted: summary row at `sent`, provider id mapped (what the worker leaves behind). */
  async function stageSent(
    channel: 'email' | 'sms',
    userId: string | null,
    provider = channel === 'email' ? 'ses' : 'twilio',
  ): Promise<{ deliveryId: string; providerMessageId: string }> {
    const deliveryId = v4();
    const providerMessageId = `${provider}-${deliveryId}`;
    await timeline().begin(
      {
        deliveryId,
        userId,
        channel,
        type: 'order.shipped',
        line: 'transactional',
      },
      t.clock.now(),
    );
    await timeline().advance(deliveryId, {
      status: 'sent',
      provider,
      providerMessageId,
      at: t.clock.now(),
    });
    await timeline().linkProvider(provider, providerMessageId, deliveryId);
    return { deliveryId, providerMessageId };
  }

  const statusOf = async (deliveryId: string) =>
    (await timeline().find(deliveryId))?.status;
  const waitForStatus = (deliveryId: string, status: DeliveryStatus) =>
    waitFor(async () => (await statusOf(deliveryId)) === status, {
      description: `delivery ${deliveryId} ${status}`,
    });
  const timelineRows = async (deliveryId: string, status: string) => {
    const res = await service(CassandraService).execute(
      'SELECT status FROM delivery_timeline WHERE delivery_id = ?',
      [deliveryId],
    );
    return res.rows.filter((r) => r.get('status') === status).length;
  };

  const sequelize = () =>
    t.app.get<Sequelize>(getConnectionToken(), { strict: false });
  const suppressionRows = (channel: string, address: string) =>
    sequelize().query<{ reason: string }>(
      'SELECT "reason" FROM "NotificationSuppression" WHERE "channel" = :channel AND "address" = :address',
      {
        replacements: { channel, address },
        type: QueryTypes.SELECT,
      },
    );
  const isSuppressed = (channel: 'email' | 'sms', address: string) =>
    service(SuppressionService).isSuppressed(channel, address);

  async function marketingEmailCell(user: TestUser): Promise<boolean> {
    const res = await t.as(user).get('/api/notifications/preferences');
    expect(res.status).toBe(200);
    return res.body.preferences.find(
      (p: { category: string }) => p.category === 'marketing',
    ).channels.email;
  }

  async function optInToMarketingEmail(user: TestUser) {
    await t
      .as(user)
      .put('/api/notifications/preferences')
      .send({ category: 'marketing', channel: 'email', enabled: true })
      .expect(200);
    expect(await marketingEmailCell(user)).toBe(true);
  }

  const smsParams = (
    sid: string,
    status: string,
    extra: Record<string, string> = {},
  ) => ({ MessageSid: sid, MessageStatus: status, ...extra });
  const twilioUrl = () =>
    `${service(ApiConfigService).get('backend_host')}/api/notifications/webhooks/twilio`;
  const postTwilio = (
    params: Record<string, string>,
    signature: string | null = twilioSignature(
      TWILIO_TOKEN,
      twilioUrl(),
      params,
    ),
  ) => {
    const req = t
      .http()
      .post('/api/notifications/webhooks/twilio')
      .type('form');
    if (signature !== null) req.set('X-Twilio-Signature', signature);
    return req.send(params);
  };

  // ---- AS-67 / AS-68 -------------------------------------------------------------------------------------------------

  it('S28 AS-67: a complaint suppresses the address, switches marketing e-mail off, marks the delivery complained and the next send never reaches the provider', async () => {
    const u = await t.newUser();
    await optInToMarketingEmail(u);
    const sent = await stageSent('email', u.id);
    await timeline().advance(sent.deliveryId, {
      status: 'delivered',
      at: t.clock.now(),
    });

    await postSes(sns(complaint(sent.providerMessageId, u.email))).expect(200);

    await waitForStatus(sent.deliveryId, 'complained');
    await waitFor(() => isSuppressed('email', u.email));
    expect(
      (await suppressionRows('email', u.email.toLowerCase()))[0].reason,
    ).toBe('complaint');
    expect(await marketingEmailCell(u)).toBe(false);

    // The next e-mail for U: timeline `suppressed`, provider not called.
    const id = v4();
    const next: DeliveryMessage = {
      deliveryId: id,
      userId: u.id,
      type: 'order.shipped',
      channel: 'email',
      priority: 'transactional',
      to: [u.email],
      subject: 'Subject',
      html: '<p>Hi</p>',
      title: 'Title',
      body: 'Body',
      link: '/orders/1',
    };
    await timeline().begin(
      {
        deliveryId: id,
        userId: u.id,
        channel: 'email',
        type: next.type,
        line: 'transactional',
      },
      t.clock.now(),
    );
    await service(DeliveryWorkerService).process('notify-email', {
      id: `msg-${id}`,
      body: next,
      attributes: {},
    });
    expect(await statusOf(id)).toBe('suppressed');
    expect(t.providers.email.calls).toHaveLength(0);
    expect(t.providers.emailFallback.calls).toHaveLength(0);
  });

  it('S28 AS-68: a permanent bounce suppresses and marks bounced; a transient one marks failed (Transient) and suppresses nothing', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    const hard = await stageSent('email', a.id);
    const soft = await stageSent('email', b.id);

    await postSes(
      sns(bounce(hard.providerMessageId, 'Permanent', a.email)),
    ).expect(200);
    await postSes(
      sns(bounce(soft.providerMessageId, 'Transient', b.email)),
    ).expect(200);

    await waitForStatus(hard.deliveryId, 'bounced');
    await waitForStatus(soft.deliveryId, 'failed');
    expect((await timeline().find(soft.deliveryId))?.providerMessageId).toBe(
      soft.providerMessageId,
    );
    expect(await isSuppressed('email', a.email)).toBe(true);
    expect(
      (await suppressionRows('email', a.email.toLowerCase()))[0].reason,
    ).toBe('hard-bounce');
    expect(await isSuppressed('email', b.email)).toBe(false);
    const detail = await service(CassandraService).execute(
      'SELECT detail FROM deliveries WHERE delivery_id = ?',
      [soft.deliveryId],
    );
    expect(detail.first()?.get('detail')).toBe('Transient');
  });

  // ---- AS-69 ---------------------------------------------------------------------------------------------------------

  describe('S28 AS-69: callback verification', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let victim: TestUser;
    let sent: { deliveryId: string; providerMessageId: string };
    beforeEach(async () => {
      victim = await t.newUser();
      sent = await stageSent('email', victim.id);
    });

    const cases: Array<[string, number, () => object | string]> = [
      [
        'a topic other than the pinned one',
        403,
        () =>
          sns(complaint('x', 'a@b.c'), {
            topic: 'arn:aws:sns:eu-central-1:999999999999:attacker',
          }),
      ],
      [
        'a forged signature',
        401,
        () =>
          sns(complaint(sent.providerMessageId, 'a@b.c'), {
            privateKey: other.privateKey,
          }),
      ],
      [
        'a tampered message body',
        401,
        () => ({
          ...sns(complaint(sent.providerMessageId, 'a@b.c')),
          Message: JSON.stringify(complaint(sent.providerMessageId, 'v@b.c')),
        }),
      ],
      [
        'a signing certificate outside the provider host pattern',
        401,
        () =>
          sns(complaint(sent.providerMessageId, 'a@b.c'), {
            certUrl: 'https://evil.example.com/cert.pem',
          }),
      ],
      [
        'a signing certificate URL that is not HTTPS',
        401,
        () =>
          sns(complaint(sent.providerMessageId, 'a@b.c'), {
            certUrl: 'http://sns.eu-central-1.amazonaws.com/cert.pem',
          }),
      ],
      [
        'a timestamp older than 5 minutes',
        401,
        () =>
          sns(complaint(sent.providerMessageId, 'a@b.c'), {
            timestamp: new Date(t.clock.now().getTime() - 6 * MINUTE),
          }),
      ],
      ['a body that is not JSON', 400, () => 'this is not json'],
      [
        'a valid envelope whose inner message is not JSON',
        400,
        () => sns('{not json'),
      ],
    ];

    it.each(cases)(
      '%s answers %i and changes nothing',
      async (_, status, body) => {
        const before = await suppressionRows('email', 'a@b.c');
        await postSes(body()).expect(status);
        expect(await queueDepth(t, CALLBACK_QUEUE_NAME)).toBe(0);
        expect(await isSuppressed('email', 'a@b.c')).toBe(false);
        expect(await suppressionRows('email', 'a@b.c')).toEqual(before);
        expect(await statusOf(sent.deliveryId)).toBe('sent');
      },
    );
  });

  // ---- AS-70 ---------------------------------------------------------------------------------------------------------

  describe('S28 AS-70: acknowledge fast, process once', () => {
    it('answers 200 once the event is durably accepted, before its effects are applied; they follow within 5 seconds', async () => {
      const u = await t.newUser();
      const sent = await stageSent('email', u.id);
      const suppression = service(SuppressionService);
      const real = suppression.suppress.bind(suppression);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      jest
        .spyOn(suppression, 'suppress')
        .mockImplementation(async (...args) => {
          await gate;
          return real(...args);
        });

      await postSes(sns(complaint(sent.providerMessageId, u.email))).expect(
        200,
      );
      expect(await isSuppressed('email', u.email)).toBe(false);
      expect(await statusOf(sent.deliveryId)).toBe('sent');

      open();
      await waitFor(() => isSuppressed('email', u.email), {
        timeoutMs: 5_000,
        description: 'suppression visible within 5 seconds',
      });
    });

    it('applies the effects of one callback id once, however many concurrent copies are posted', async () => {
      const u = await t.newUser();
      const sent = await stageSent('email', u.id);
      const body = sns(complaint(sent.providerMessageId, u.email));
      const applied = callbacks('ses', 'applied');

      const results = await inParallel(10, () => postSes(body));
      for (const r of results) {
        expect(r.status).toBe('fulfilled');
        if (r.status === 'fulfilled') expect(r.value.status).toBe(200);
      }

      await waitForStatus(sent.deliveryId, 'complained');
      await waitForQueueEmpty(t, CALLBACK_QUEUE_NAME);
      expect(await timelineRows(sent.deliveryId, 'complained')).toBe(1);
      expect(callbacks('ses', 'applied')).toBe(applied + 1);
      expect(
        await suppressionRows('email', u.email.toLowerCase()),
      ).toHaveLength(1);
    });

    it('a failure while applying leaves the event retriable: it is applied after the queue redelivers it', async () => {
      const u = await t.newUser();
      const sent = await stageSent('email', u.id);
      const suppression = service(SuppressionService);
      const real = suppression.suppress.bind(suppression);
      let failures = 1;
      jest.spyOn(suppression, 'suppress').mockImplementation((...args) => {
        if (failures-- > 0) return Promise.reject(new Error('store down'));
        return real(...args);
      });

      await postSes(sns(complaint(sent.providerMessageId, u.email))).expect(
        200,
      );

      await waitFor(() => isSuppressed('email', u.email));
      await waitForStatus(sent.deliveryId, 'complained');
      expect(await timelineRows(sent.deliveryId, 'complained')).toBe(1);
    });

    it('a malformed queue message is dead-lettered without being applied (VII.4)', async () => {
      const before = metric('notifications_dead_letter_total', {
        source: CALLBACK_QUEUE_NAME,
        reason: 'invalid_message',
      });
      await service(TaskQueue).enqueue(CALLBACK_QUEUE_NAME, {
        provider: 'ses',
        nonsense: true,
      });
      await waitFor(
        async () =>
          metric('notifications_dead_letter_total', {
            source: CALLBACK_QUEUE_NAME,
            reason: 'invalid_message',
          }) ===
          before + 1,
      );
    });
  });

  // ---- AS-72 / AS-77 -------------------------------------------------------------------------------------------------

  it('S28 AS-72: a callback that raced our own record is held and applied once the mapping appears', async () => {
    const u = await t.newUser();
    const deliveryId = v4();
    const providerMessageId = `ses-${deliveryId}`;
    const deferred = callbacks('ses', 'deferred');

    await postSes(sns(delivery(providerMessageId))).expect(200);
    await waitFor(async () => callbacks('ses', 'deferred') > deferred);

    await timeline().begin(
      {
        deliveryId,
        userId: u.id,
        channel: 'email',
        type: 'order.shipped',
        line: 'transactional',
      },
      t.clock.now(),
    );
    await timeline().advance(deliveryId, {
      status: 'sent',
      provider: 'ses',
      providerMessageId,
      at: t.clock.now(),
    });
    await timeline().linkProvider('ses', providerMessageId, deliveryId);

    await waitForStatus(deliveryId, 'delivered');
    expect(await timelineRows(deliveryId, 'delivered')).toBe(1);
  });

  it('S28 AS-72: after 10 minutes without a mapping the callback is dropped and counted', async () => {
    const before = dropped();
    const acceptedAt = new Date(t.clock.now().getTime() - 11 * MINUTE);
    await service(CallbackWorkerService).process({
      id: 'msg-old',
      attributes: {},
      body: {
        provider: 'ses',
        eventId: v4(),
        acceptedAt: acceptedAt.toISOString(),
        payload: {
          kind: 'delivery',
          messageId: 'ses-never-recorded',
          recipients: [],
        },
      },
    });
    expect(dropped()).toBe(before + 1);
  });

  it('S28 AS-77: a complaint for an unknown delivery still suppresses the address, changes no preference and counts the status part as dropped', async () => {
    const u = await t.newUser();
    await optInToMarketingEmail(u);
    await postSes(sns(complaint('ses-unknown', u.email))).expect(200);
    await waitFor(() => isSuppressed('email', u.email));
    expect(await marketingEmailCell(u)).toBe(true);

    const before = dropped();
    await service(CallbackWorkerService).process({
      id: 'msg-old-complaint',
      attributes: {},
      body: {
        provider: 'ses',
        eventId: v4(),
        acceptedAt: new Date(
          t.clock.now().getTime() - 11 * MINUTE,
        ).toISOString(),
        payload: {
          kind: 'complaint',
          messageId: 'ses-unknown',
          recipients: ['someone.else@example.com'],
        },
      },
    });
    expect(dropped()).toBe(before + 1);
    expect(await isSuppressed('email', 'someone.else@example.com')).toBe(true);
    expect(await marketingEmailCell(u)).toBe(true);
  });

  // ---- AS-73 ---------------------------------------------------------------------------------------------------------

  describe('S28 AS-73: subscription confirmation', () => {
    const confirmation = (subscribeUrl: string) =>
      sns('You have chosen to subscribe', {}, 'SubscriptionConfirmation', {
        SubscribeURL: subscribeUrl,
        Token: 'token-1',
      });

    it('confirms through the provider HTTPS host with a 5-second timeout', async () => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('ok'));
      const url =
        'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=token-1';
      await postSes(confirmation(url)).expect(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0].toString()).toBe(url);
      expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([
      ['another host', 'https://evil.example.com/?Action=ConfirmSubscription'],
      [
        'a lookalike host',
        'https://sns.eu-central-1.amazonaws.com.evil.example.com/confirm',
      ],
      [
        'plain HTTP',
        'http://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription',
      ],
    ])('answers 400 and makes no outbound request for %s', async (_, url) => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('ok'));
      await postSes(confirmation(url)).expect(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ---- AS-74 / AS-75 -------------------------------------------------------------------------------------------------

  it('S28 AS-74: SMS status callbacks record delivered and failed, and a STOP suppresses the E.164 number', async () => {
    const phone = '+380501234567';
    const ok = await stageSent('sms', null);
    const bad = await stageSent('sms', null);
    const stop = await stageSent('sms', null);

    await postTwilio(smsParams(ok.providerMessageId, 'delivered')).expect(204);
    await postTwilio(
      smsParams(bad.providerMessageId, 'failed', { ErrorCode: '30003' }),
    ).expect(204);
    await postTwilio(
      smsParams(stop.providerMessageId, 'undelivered', {
        ErrorCode: '21610',
        To: ` ${phone.slice(0, 4)} ${phone.slice(4)} `,
      }),
    ).expect(204);

    await waitForStatus(ok.deliveryId, 'delivered');
    await waitForStatus(bad.deliveryId, 'failed');
    await waitForStatus(stop.deliveryId, 'failed');
    await waitFor(() => isSuppressed('sms', phone));
    expect((await suppressionRows('sms', phone))[0].reason).toBe('sms-stop');
  });

  it('S28 AS-74: a missing or invalid signature, or an unconfigured signing key, answers 401 with no effect', async () => {
    const sms = await stageSent('sms', null);
    const params = smsParams(sms.providerMessageId, 'delivered');

    await postTwilio(params, null).expect(401);
    await postTwilio(params, 'bm90LXRoZS1zaWduYXR1cmU=').expect(401);
    const config = service(ApiConfigService);
    const real = config.get.bind(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation(((key: string) =>
        key === 'twilio_auth_token'
          ? undefined
          : real(key as never)) as typeof config.get);
    await postTwilio(params).expect(401);

    expect(await queueDepth(t, CALLBACK_QUEUE_NAME)).toBe(0);
    expect(await statusOf(sms.deliveryId)).toBe('sent');
  });

  it('S28 AS-75: the same signed SMS callback twice has no further effect', async () => {
    const phone = '+380507654321';
    const sms = await stageSent('sms', null);
    const stopped = await stageSent('sms', null);
    const delivered = smsParams(sms.providerMessageId, 'delivered');
    const stop = smsParams(stopped.providerMessageId, 'undelivered', {
      ErrorCode: '21610',
      To: phone,
    });

    await postTwilio(delivered).expect(204);
    await postTwilio(stop).expect(204);
    await waitForStatus(sms.deliveryId, 'delivered');
    await waitFor(() => isSuppressed('sms', phone));

    await postTwilio(delivered).expect(204);
    await postTwilio(stop).expect(204);
    await waitForQueueEmpty(t, CALLBACK_QUEUE_NAME);

    expect(await timelineRows(sms.deliveryId, 'delivered')).toBe(1);
    expect(await timelineRows(stopped.deliveryId, 'failed')).toBe(1);
    expect(await suppressionRows('sms', phone)).toHaveLength(1);
  });

  // ---- AS-76 ---------------------------------------------------------------------------------------------------------

  it('S28 AS-76: suppression normalizes, is idempotent, is per channel and takes effect for the very next check', async () => {
    const suppression = service(SuppressionService);
    expect(await suppression.isSuppressed('email', 'alice@mail.com')).toBe(
      false,
    );

    await suppression.suppress('email', ['Alice@Mail.com '], 'complaint');
    expect(await suppression.isSuppressed('email', 'alice@mail.com')).toBe(
      true,
    );
    expect(await suppression.isSuppressed('email', ' ALICE@mail.COM')).toBe(
      true,
    );

    await suppression.suppress(
      'email',
      ['alice@mail.com', 'ALICE@mail.com'],
      'complaint',
    );
    expect(await suppressionRows('email', 'alice@mail.com')).toHaveLength(1);

    await suppression.suppress('sms', [' +380 50 123 4567 '], 'sms-stop');
    expect(await suppression.isSuppressed('sms', '+380501234567')).toBe(true);
    expect(await suppressionRows('sms', '+380501234567')).toHaveLength(1);

    // Per channel: a suppressed e-mail address does not block an SMS number, and the reverse.
    expect(await suppression.isSuppressed('sms', 'alice@mail.com')).toBe(false);
    expect(await suppression.isSuppressed('email', '+380501234567')).toBe(
      false,
    );
  });
});
