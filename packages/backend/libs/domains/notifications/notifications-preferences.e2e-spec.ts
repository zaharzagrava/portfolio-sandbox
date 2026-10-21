import { v4 } from 'uuid';
import { issueSession } from '@app/test/seeds/session.fixture';
import {
  deviceListSchema,
  deviceSchema,
  notificationPreferencesSchema,
  type NotificationPreferences,
} from '@marketplace-sandbox/contracts';
import {
  DEVICE_REPOSITORY,
  PREFERENCE_REPOSITORY,
  SUPPRESSION_REPOSITORY,
  DELIVERY_TIMELINE_STORE,
  type DeliveryTimelineStore,
  type DeviceRepository,
  type PreferenceRepository,
  type SuppressionRepository,
} from './domain/ports';
import { CATEGORIES, CHANNELS, NOTIFICATION_TYPES } from './domain/catalog';
import { deliveryIdFor, identityOf } from './domain/ids';
import { unsubscribeHeaders } from './infra/providers/ses-email.provider';
import {
  consume,
  createNotificationsApp,
  envelope,
  orderPaidEnvelope,
  waitFor as waitForSoon,
  waitForQueueEmpty,
  type NotificationsTestApp,
  type TestUser,
} from './testing';

const waitFor: typeof waitForSoon = (probe, options = {}) =>
  waitForSoon(probe, { timeoutMs: 45_000, intervalMs: 30, ...options });

const PHONE = '+380501234567';
const MASKED = '+380•••••4567';

describe('Notifications: preferences, settings, phone verification, devices and unsubscribe', () => {
  let t: NotificationsTestApp;
  const port = <T>(token: symbol) => t.app.get<T>(token, { strict: false });

  beforeAll(async () => {
    t = await createNotificationsApp({ env: { EMAIL_PROVIDER: 'memory' } });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => t.reset());

  const matrixOf = async (user: TestUser): Promise<NotificationPreferences> =>
    notificationPreferencesSchema.parse(
      (await t.as(user).get('/api/notifications/preferences').expect(200)).body,
    );
  const cellOf = (
    m: NotificationPreferences,
    category: string,
    channel: 'email' | 'sms' | 'push' | 'inapp',
  ) => m.preferences.find((p) => p.category === category)!.channels[channel];
  const setCell = (
    user: TestUser,
    category: string,
    channel: string,
    enabled: boolean,
  ) =>
    t
      .as(user)
      .put('/api/notifications/preferences')
      .send({ category, channel, enabled });
  const putSettings = (user: TestUser, body: Record<string, unknown>) =>
    t.as(user).put('/api/notifications/settings').send(body);
  const emailsTo = (user: TestUser) => t.providers.email.callsTo(user.email);
  const smsTo = (phone: string) => t.providers.sms.callsTo(phone);
  const codeSentTo = async (phone: string, nth = 1): Promise<string> => {
    const calls = await waitFor(
      async () => smsTo(phone).length >= nth && smsTo(phone),
      { description: `verification sms #${nth}` },
    );
    expect(calls[nth - 1].type).toBe('security.phone_verification');
    const code = /\b(\d{6})\b/.exec(calls[nth - 1].body)?.[1];
    expect(code).toBeDefined();
    return code!;
  };
  const wrongCodeFor = (code: string) =>
    code === '000000' ? '111111' : '000000';
  const addDevice = (user: TestUser, token: string) =>
    port<DeviceRepository>(DEVICE_REPOSITORY).register(
      { userId: user.id, token, platform: 'ios' },
      10,
      t.clock.now(),
    );
  const verifyPhone = async (user: TestUser, phone = PHONE) => {
    await putSettings(user, { phone }).expect(200);
    const code = await codeSentTo(phone);
    await t
      .as(user)
      .post('/api/notifications/settings/phone/verify')
      .send({ code })
      .expect(200);
  };
  const problem = (res: { body: Record<string, unknown> }) => res.body.code;

  it('S28 AS-14: a new user sees the default matrix: inapp on, sms off, marketing external off, mandatory channels listed', async () => {
    const user = await t.newUser();
    const m = await matrixOf(user);

    expect(m.settings).toEqual({
      timezone: 'UTC',
      locale: 'en',
      quietStart: null,
      quietEnd: null,
      phone: null,
      phoneVerified: false,
    });
    expect(m.preferences.map((p) => p.category).sort()).toEqual(
      [...CATEGORIES].sort(),
    );
    const defaults = (category: string) =>
      new Set(
        Object.values(NOTIFICATION_TYPES)
          .filter((d) => d.category === category)
          .flatMap((d) => d.channels),
      );
    for (const row of m.preferences) {
      expect(row.channels.inapp).toBe(true);
      expect(row.channels.sms).toBe(false);
      for (const channel of ['email', 'push'] as const)
        expect(row.channels[channel]).toBe(
          row.category !== 'marketing' && defaults(row.category).has(channel),
        );
    }
    expect(cellOf(m, 'marketing', 'email')).toBe(false);
    expect(cellOf(m, 'marketing', 'push')).toBe(false);
    expect(cellOf(m, 'orders', 'email')).toBe(true);
    expect(
      m.preferences.find((p) => p.category === 'security')!.mandatoryChannels,
    ).toContain('email');
    expect(
      m.preferences.find((p) => p.category === 'marketing')!.mandatoryChannels,
    ).toEqual([]);
    for (const row of m.preferences)
      expect(row.mandatoryChannels).not.toContain('sms');
  });

  it('S28 AS-15: changing a cell shows in the matrix and in routing; repeating it changes nothing', async () => {
    const user = await t.newUser();
    await addDevice(user, `tok-${v4()}`);

    // warm the recipient view, then flip the cell
    await consume(t, [orderPaidEnvelope({ userId: user.id })]);
    await waitFor(async () => emailsTo(user).length === 1, {
      description: 'the first e-mail',
    });

    const first = await setCell(user, 'orders', 'email', false).expect(200);
    const second = await setCell(user, 'orders', 'email', false).expect(200);
    expect(second.body).toEqual(first.body);
    const m = notificationPreferencesSchema.parse(first.body);
    expect(cellOf(m, 'orders', 'email')).toBe(false);
    expect(cellOf(m, 'orders', 'push')).toBe(true);

    t.providers.push.reset();
    await consume(t, [orderPaidEnvelope({ userId: user.id })]);
    await waitFor(async () => t.providers.push.calls.length === 1, {
      description: 'the push',
    });
    await waitForQueueEmpty(t, 'notify-email');
    expect(emailsTo(user)).toHaveLength(1); // none for the second order
    const inbox = (await t.as(user).get('/api/notifications').expect(200)).body;
    expect(inbox.items).toHaveLength(2);

    await setCell(user, 'orders', 'email', true).expect(200);
    await consume(t, [orderPaidEnvelope({ userId: user.id })]);
    await waitFor(async () => emailsTo(user).length === 2, {
      description: 'the e-mail after turning it back on',
    });
  });

  it('S28 AS-16: invalid preference input is 400 and stores nothing; no credentials is 401; the 61st write in a minute is 429', async () => {
    const user = await t.newUser();
    await t
      .http()
      .put('/api/notifications/preferences')
      .send({ category: 'orders', channel: 'email', enabled: false })
      .expect(401);

    const bad: Array<Record<string, unknown>> = [
      { category: 'nope', channel: 'email', enabled: false },
      { category: 'orders', channel: 'carrier-pigeon', enabled: false },
      { category: 'orders', channel: 'email', enabled: 'no' },
      { category: 'orders', channel: 'email' },
      { category: 'orders', enabled: false },
      { category: 'orders', channel: 'email', enabled: false, extra: 1 },
    ];
    for (const body of bad) {
      const res = await t
        .as(user)
        .put('/api/notifications/preferences')
        .send(body)
        .expect(400);
      expect(problem(res)).toBe('validation_failed');
    }
    expect(cellOf(await matrixOf(user), 'orders', 'email')).toBe(true);

    const statuses = await Promise.all(
      Array.from({ length: 70 }, () =>
        setCell(user, 'orders', 'push', true).then((r) => ({
          status: r.status,
          retryAfter: r.headers['retry-after'],
        })),
      ),
    );
    const limited = statuses.filter((s) => s.status === 429);
    expect(limited.length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s.status === 200).length).toBeLessThanOrEqual(
      66,
    );
    expect(Number(limited[0].retryAfter)).toBeGreaterThan(0);
  });

  it('S28 AS-17: mandatory notices ignore opt-outs but never the suppression list', async () => {
    const user = await t.newUser();
    const prefs = port<PreferenceRepository>(PREFERENCE_REPOSITORY);
    for (const category of CATEGORIES)
      for (const channel of CHANNELS)
        await prefs.set(user.id, category, channel, false, t.clock.now());

    await consume(t, [
      envelope('billing.invoice_payment_failed', {
        subjectType: 'USER',
        subjectId: user.id,
        attempt: 1,
        nextAttemptAt: null,
      }),
      envelope('identity.password_changed', { userId: user.id }),
    ]);
    await waitFor(async () => emailsTo(user).length === 2, {
      description: 'both mandatory e-mails',
    });
    expect(
      (await t.as(user).get('/api/notifications').expect(200)).body.items
        .length,
    ).toBeGreaterThanOrEqual(1);

    const suppressed = envelope('identity.password_changed', {
      userId: user.id,
    });
    await port<SuppressionRepository>(SUPPRESSION_REPOSITORY).add(
      'email',
      user.email.toLowerCase(),
      'manual',
      t.clock.now(),
    );
    await consume(t, [suppressed]);
    const id = deliveryIdFor(
      identityOf(suppressed.eventId, { kind: 'user', userId: user.id }),
      'email',
    );
    await waitFor(
      async () =>
        (await port<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE).find(id))
          ?.status === 'suppressed',
      { description: 'the suppressed status' },
    );
    expect(emailsTo(user)).toHaveLength(2);
  });

  it('S28 AS-18: sms needs a verified phone; once verified it carries a later order; a changed phone loses it again', async () => {
    const user = await t.newUser();
    await putSettings(user, { phone: PHONE }).expect(200);
    const rejected = await setCell(user, 'orders', 'sms', true).expect(422);
    expect(problem(rejected)).toBe('phone_not_verified');
    expect(cellOf(await matrixOf(user), 'orders', 'sms')).toBe(false);

    const code = await codeSentTo(PHONE);
    await t
      .as(user)
      .post('/api/notifications/settings/phone/verify')
      .send({ code })
      .expect(200);
    const m = notificationPreferencesSchema.parse(
      (await setCell(user, 'orders', 'sms', true).expect(200)).body,
    );
    expect(cellOf(m, 'orders', 'sms')).toBe(true);

    await consume(t, [orderPaidEnvelope({ userId: user.id })]);
    await waitFor(
      async () =>
        smsTo(PHONE).filter((c) => c.type === 'order.confirmed').length === 1,
      { description: 'the order sms' },
    );

    const other = '+380671112233';
    const changed = notificationPreferencesSchema.parse(
      (await putSettings(user, { phone: other }).expect(200)).body,
    );
    expect(changed.settings.phoneVerified).toBe(false);
    await consume(t, [orderPaidEnvelope({ userId: user.id })]);
    await waitFor(async () => emailsTo(user).length === 2, {
      description: 'the second e-mail',
    });
    await waitForQueueEmpty(t, 'notify-sms');
    expect(
      t.providers.sms.calls.filter((c) => c.type === 'order.confirmed'),
    ).toHaveLength(1);
  });

  it('S28 AS-19: settings take effect for the next notification in every process: language and the zone of the quiet hours', async () => {
    const user = await t.newUser();
    await addDevice(user, `tok-${v4()}`);
    await consume(t, [orderPaidEnvelope({ userId: user.id })]); // warms the view with the old settings

    // a window around "now" in Kyiv time, which is not a window around now in UTC
    const hhmm = (at: Date) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Kyiv',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(at);
    const now = t.clock.now();
    const quietStart = hhmm(new Date(now.getTime() - 3_600_000));
    const quietEnd = hhmm(new Date(now.getTime() + 3_600_000));

    const res = await putSettings(user, {
      timezone: 'Europe/Kyiv',
      locale: 'uk',
      quietStart,
      quietEnd,
    }).expect(200);
    const m = notificationPreferencesSchema.parse(res.body);
    expect(m.settings).toMatchObject({
      timezone: 'Europe/Kyiv',
      locale: 'uk',
      quietStart,
      quietEnd,
    });
    expect((await matrixOf(user)).settings).toEqual(m.settings);

    const event = orderPaidEnvelope({ userId: user.id });
    await consume(t, [event]);
    const items = (await t.as(user).get('/api/notifications').expect(200)).body
      .items as Array<{ title: string }>;
    expect(items[0].title).toBe('Замовлення підтверджено');
    const id = deliveryIdFor(
      identityOf(event.eventId, { kind: 'user', userId: user.id }),
      'push',
    );
    await waitFor(
      async () =>
        (await port<DeliveryTimelineStore>(DELIVERY_TIMELINE_STORE).find(id))
          ?.status === 'delayed',
      { description: 'the push to be held by the Kyiv quiet hours' },
    );
  });

  it('S28 AS-20: settings are validated: format errors 400, a half-set or equal quiet window 422, nothing stored on failure', async () => {
    const user = await t.newUser();
    await t.http().put('/api/notifications/settings').send({}).expect(401);

    for (const body of [
      { timezone: 'Mars/Base' },
      { locale: 'english' },
      { quietStart: '25:00', quietEnd: '07:00' },
      { phone: '0501234567' },
      { surprise: true },
    ]) {
      const res = await putSettings(user, body).expect(400);
      expect(problem(res)).toBe('validation_failed');
    }
    const incomplete = await putSettings(user, { quietStart: '22:00' }).expect(
      422,
    );
    expect(problem(incomplete)).toBe('quiet_hours_incomplete');
    const equal = await putSettings(user, {
      quietStart: '22:00',
      quietEnd: '22:00',
    }).expect(422);
    expect(problem(equal)).toBe('quiet_hours_invalid');
    expect((await matrixOf(user)).settings).toMatchObject({
      timezone: 'UTC',
      quietStart: null,
      quietEnd: null,
    });

    await putSettings(user, { quietStart: '22:00', quietEnd: '07:30' }).expect(
      200,
    );
    // moving one end keeps the pair; dropping one end alone would leave half a window
    await putSettings(user, { quietStart: '23:00' }).expect(200);
    const half = await putSettings(user, { quietEnd: null }).expect(422);
    expect(problem(half)).toBe('quiet_hours_incomplete');
    expect((await matrixOf(user)).settings).toMatchObject({
      quietStart: '23:00',
      quietEnd: '07:30',
    });

    const cleared = notificationPreferencesSchema.parse(
      (
        await putSettings(user, { quietStart: null, quietEnd: null }).expect(
          200,
        )
      ).body,
    );
    expect(cleared.settings).toMatchObject({
      quietStart: null,
      quietEnd: null,
    });
  });

  it('S28 AS-21: a phone is verified with a 6 digit code sent at once; it is masked; changing it resets the verification', async () => {
    const user = await t.newUser();
    const res = await putSettings(user, { phone: PHONE }).expect(200);
    const m = notificationPreferencesSchema.parse(res.body);
    expect(m.settings).toMatchObject({ phone: MASKED, phoneVerified: false });
    expect(JSON.stringify(res.body)).not.toContain(PHONE);

    const code = await codeSentTo(PHONE);
    expect(code).toMatch(/^\d{6}$/);
    expect(smsTo(PHONE)[0].to).toEqual([PHONE]);

    const verified = notificationPreferencesSchema.parse(
      (
        await t
          .as(user)
          .post('/api/notifications/settings/phone/verify')
          .send({ code })
          .expect(200)
      ).body,
    );
    expect(verified.settings).toMatchObject({
      phone: MASKED,
      phoneVerified: true,
    });

    const changed = notificationPreferencesSchema.parse(
      (await putSettings(user, { phone: '+380671112233' }).expect(200)).body,
    );
    expect(changed.settings.phoneVerified).toBe(false);

    // clearing the phone clears the verification and voids any pending code
    const pending = await codeSentTo('+380671112233');
    const cleared = notificationPreferencesSchema.parse(
      (await putSettings(user, { phone: null }).expect(200)).body,
    );
    expect(cleared.settings).toMatchObject({
      phone: null,
      phoneVerified: false,
    });
    const late = await t
      .as(user)
      .post('/api/notifications/settings/phone/verify')
      .send({ code: pending })
      .expect(422);
    expect(problem(late)).toBe('code_not_requested');
  });

  it('S28 AS-22: wrong codes count down and lock for 15 minutes; an expired, absent or used code is refused', async () => {
    const user = await t.newUser();
    await putSettings(user, { phone: PHONE }).expect(200);
    const code = await codeSentTo(PHONE);
    const verify = (c: string) =>
      t
        .as(user)
        .post('/api/notifications/settings/phone/verify')
        .send({ code: c });
    const wrong = wrongCodeFor(code);

    for (const left of [4, 3, 2, 1]) {
      const res = await verify(wrong).expect(422);
      expect(res.body).toMatchObject({
        code: 'code_invalid',
        attemptsLeft: left,
      });
    }
    const locked = await verify(wrong).expect(429);
    expect(locked.body.code).toBe('verification_locked');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(890);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(900);
    const stillLocked = await verify(code).expect(429); // even the right one
    expect(stillLocked.body.code).toBe('verification_locked');
    expect(Number(stillLocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await matrixOf(user)).settings.phoneVerified).toBe(false);

    // no code was ever requested
    const fresh = await t.newUser();
    const none = await t
      .as(fresh)
      .post('/api/notifications/settings/phone/verify')
      .send({ code: '123456' })
      .expect(422);
    expect(none.body.code).toBe('code_not_requested');

    // a code older than 10 minutes
    const late = await t.newUser();
    const phone = '+380931112233';
    await putSettings(late, { phone }).expect(200);
    const lateCode = await codeSentTo(phone);
    t.clock.advance(10 * 60_000 + 1_000);
    // the access token (300 s) is past its life on the advanced clock: sign in again
    const renewed = {
      ...late,
      bearer: (await issueSession(t.app, { id: late.id, role: 'USER' })).bearer,
    };
    const expired = await t
      .as(renewed)
      .post('/api/notifications/settings/phone/verify')
      .send({ code: lateCode })
      .expect(422);
    expect(expired.body.code).toBe('code_expired');

    // a used code cannot be reused
    const user2 = await t.newUser();
    const phone2 = '+380941112233';
    await putSettings(user2, { phone: phone2 }).expect(200);
    const code2 = await codeSentTo(phone2);
    const send = () =>
      t
        .as(user2)
        .post('/api/notifications/settings/phone/verify')
        .send({ code: code2 });
    await send().expect(200);
    const reused = await send().expect(422);
    expect(reused.body.code).toBe('code_not_requested');
  });

  it('S28 AS-23: three code requests per hour; a missing phone is 422 phone_missing; a suppressed phone is 422 phone_unreachable', async () => {
    const user = await t.newUser();
    const noPhone = await t
      .as(await t.newUser())
      .post('/api/notifications/settings/phone/code')
      .expect(422);
    expect(noPhone.body.code).toBe('phone_missing');

    await putSettings(user, { phone: PHONE }).expect(200); // request 1
    for (let n = 0; n < 2; n++) {
      const res = await t
        .as(user)
        .post('/api/notifications/settings/phone/code')
        .expect(202);
      expect(res.body).toEqual({});
    }
    await codeSentTo(PHONE, 3);

    const fourth = await t
      .as(user)
      .post('/api/notifications/settings/phone/code')
      .expect(429);
    expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(0);
    // a settings update that would send a code is counted the same way
    await putSettings(user, { phone: '+380671112233' }).expect(429);
    await waitForQueueEmpty(t, 'notify-sms');
    expect(t.providers.sms.calls).toHaveLength(3);

    const other = await t.newUser();
    const phone = '+380951112233';
    await putSettings(other, { phone }).expect(200);
    await codeSentTo(phone);
    await port<SuppressionRepository>(SUPPRESSION_REPOSITORY).add(
      'sms',
      phone,
      'stop',
      t.clock.now(),
    );
    const unreachable = await t
      .as(other)
      .post('/api/notifications/settings/phone/code')
      .expect(422);
    expect(unreachable.body.code).toBe('phone_unreachable');
    await waitForQueueEmpty(t, 'notify-sms');
    expect(smsTo(phone)).toHaveLength(1);
  });

  it('S28 AS-24: concurrent writes end in one consistent state (20 users, 4 racing writes each)', async () => {
    const users = await Promise.all(
      Array.from({ length: 20 }, () => t.newUser()),
    );
    await Promise.all(
      users.map(async (user) => {
        const results = await Promise.all([
          setCell(user, 'orders', 'email', false),
          setCell(user, 'orders', 'email', true),
          setCell(user, 'shop', 'push', false),
          setCell(user, 'billing', 'email', false),
        ]);
        expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
        const first = await matrixOf(user);
        const second = await matrixOf(user);
        expect(second).toEqual(first);
        expect(typeof cellOf(first, 'orders', 'email')).toBe('boolean');
        expect(cellOf(first, 'shop', 'push')).toBe(false);
        expect(cellOf(first, 'billing', 'email')).toBe(false);
        for (const r of results)
          expect(() =>
            notificationPreferencesSchema.parse(r.body),
          ).not.toThrow();
      }),
    );
  });

  describe('unsubscribe', () => {
    const pathOf = (url: string) => {
      const u = new URL(url);
      return u.pathname + u.search;
    };
    const mailWithLink = async (user: TestUser) => {
      await consume(t, [orderPaidEnvelope({ userId: user.id })]);
      const [mail] = await waitFor(
        async () => emailsTo(user).length >= 1 && emailsTo(user),
        { description: 'the order e-mail' },
      );
      return mail;
    };
    const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;

    it('S28 AS-25: GET describes and changes nothing; POST unsubscribes that category by e-mail only, repeatably', async () => {
      const user = await t.newUser();
      const mail = await mailWithLink(user);
      const path = pathOf(mail.unsubscribeUrl!);

      const described = await t.http().get(path).expect(200);
      expect(described.body).toEqual({ category: 'orders' });
      expect(cellOf(await matrixOf(user), 'orders', 'email')).toBe(true);

      await t.http().post(path).expect(200, { unsubscribed: 'orders' });
      await t
        .http()
        .post(path)
        .type('form')
        .send('List-Unsubscribe=One-Click')
        .expect(200, { unsubscribed: 'orders' });
      const m = await matrixOf(user);
      expect(cellOf(m, 'orders', 'email')).toBe(false);
      expect(cellOf(m, 'orders', 'push')).toBe(true);
      expect(cellOf(m, 'shop', 'email')).toBe(true);

      await consume(t, [orderPaidEnvelope({ userId: user.id })]);
      await waitForQueueEmpty(t, 'notify-email');
      expect(emailsTo(user)).toHaveLength(1);
    });

    it('S28 AS-26: forged, tampered, foreign and empty tokens are the same 400 and change nothing; a flood from one address is 429', async () => {
      const user = await t.newUser();
      const stranger = await t.newUser();
      const mail = await mailWithLink(user);
      const token = tokenOf(mail.unsubscribeUrl!);
      const [payload, mac] = token.split('.');
      const claims = Buffer.from(payload, 'base64url').toString().split('|');
      const reencode = (parts: string[]) =>
        `${Buffer.from(parts.join('|')).toString('base64url')}.${mac}`;

      const bad = [
        'forged.token',
        reencode([claims[0], 'billing', ...claims.slice(2)]),
        reencode([stranger.id, ...claims.slice(1)]),
        '',
      ];
      const bodies: unknown[] = [];
      for (const value of bad) {
        const res = await t
          .http()
          .post(`/api/notifications/unsubscribe?token=${value}`)
          .expect(400);
        expect(res.body.code).toBe('invalid_unsubscribe_token');
        bodies.push(res.body.detail);
      }
      await t.http().get('/api/notifications/unsubscribe').expect(400);
      expect(new Set(bodies).size).toBe(1);
      expect(cellOf(await matrixOf(user), 'orders', 'email')).toBe(true);
      expect(cellOf(await matrixOf(stranger), 'orders', 'email')).toBe(true);
      expect(cellOf(await matrixOf(stranger), 'billing', 'email')).toBe(true);

      // more than 30 requests in a minute from one address
      let limited: { retryAfter?: string } | null = null;
      for (let n = 0; n < 40 && !limited; n++) {
        const res = await t
          .http()
          .post('/api/notifications/unsubscribe?token=garbage.token');
        if (res.status === 429)
          limited = { retryAfter: res.headers['retry-after'] };
      }
      expect(limited).not.toBeNull();
      expect(Number(limited!.retryAfter)).toBeGreaterThan(0);
      const valid = await t
        .http()
        .post(`/api/notifications/unsubscribe?token=${token}`)
        .expect(429);
      expect(valid.body.code).toBe('rate_limited');
      expect(cellOf(await matrixOf(user), 'orders', 'email')).toBe(true);
    });
  });

  it('S28 AS-27: only non-mandatory e-mail carries the unsubscribe link, and the adapter turns it into both one-click headers', async () => {
    const user = await t.newUser();
    await consume(t, [
      orderPaidEnvelope({ userId: user.id }),
      envelope('identity.password_changed', { userId: user.id }),
    ]);
    const mails = await waitFor(
      async () => emailsTo(user).length === 2 && emailsTo(user),
      { description: 'both e-mails' },
    );
    const optional = mails.find((m) => m.type === 'order.confirmed')!;
    const mandatory = mails.find(
      (m) => m.type === 'security.password_changed',
    )!;

    expect(optional.unsubscribeUrl).toMatch(
      /\/api\/notifications\/unsubscribe\?token=.+/,
    );
    expect(mandatory.unsubscribeUrl).toBeUndefined();
    expect(unsubscribeHeaders(optional)).toEqual([
      ['List-Unsubscribe', `<${optional.unsubscribeUrl}>`],
      ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click'],
    ]);
    expect(unsubscribeHeaders(mandatory)).toEqual([]);
  });

  describe('devices', () => {
    const register = (user: TestUser, body: Record<string, unknown>) =>
      t.as(user).post('/api/notifications/devices').send(body);
    const listOf = async (user: TestUser) =>
      deviceListSchema.parse(
        (await t.as(user).get('/api/notifications/devices').expect(200)).body,
      ).items;

    it('S28 AS-28: devices are registered without exposing the token, move to the latest user, are capped at 10 and validated', async () => {
      const a = await t.newUser();
      const b = await t.newUser();
      const token = `tok-${v4()}`;

      const created = await register(a, { token, platform: 'ios' }).expect(201);
      const device = deviceSchema.parse(created.body);
      expect(JSON.stringify(created.body)).not.toContain(token);
      const again = await register(a, { token, platform: 'ios' }).expect(200);
      expect(deviceSchema.parse(again.body).id).toBe(device.id);
      const listed = await listOf(a);
      expect(listed.map((d) => d.id)).toEqual([device.id]);
      expect(Object.keys(listed[0]).sort()).toEqual([
        'id',
        'lastSeenAt',
        'platform',
      ]);

      // the token moves to the user who registered it last, and so do its pushes (a's cached view is dropped)
      await consume(t, [orderPaidEnvelope({ userId: a.id })]);
      await waitFor(async () => t.providers.push.calls.length === 1, {
        description: 'the push to the first owner',
      });
      t.providers.push.reset();
      await register(b, { token, platform: 'android' }).expect(200);
      expect(await listOf(a)).toEqual([]);
      expect(await listOf(b)).toHaveLength(1);
      await consume(t, [orderPaidEnvelope({ userId: a.id })]);
      await waitFor(async () => emailsTo(a).length === 2, {
        description: 'the second e-mail for the former owner',
      });
      await waitForQueueEmpty(t, 'notify-push');
      expect(t.providers.push.calls).toHaveLength(0);

      // the 11th device evicts the least recently seen
      const c = await t.newUser();
      const first = await register(c, {
        token: `tok-${v4()}`,
        platform: 'web',
      }).expect(201);
      for (let n = 1; n < 11; n++) {
        await new Promise((r) => setTimeout(r, 5));
        await register(c, { token: `tok-${v4()}`, platform: 'web' }).expect(
          201,
        );
      }
      const ids = (await listOf(c)).map((d) => d.id);
      expect(ids).toHaveLength(10);
      expect(ids).not.toContain(first.body.id);

      // invalid input and no credentials
      for (const body of [
        { token: '', platform: 'ios' },
        { token: 'x'.repeat(4097), platform: 'ios' },
        { token: 'ok', platform: 'symbian' },
        { platform: 'ios' },
      ]) {
        const res = await register(a, body).expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
      await t
        .http()
        .post('/api/notifications/devices')
        .send({ token: 'x', platform: 'ios' })
        .expect(401);
      await t.http().get('/api/notifications/devices').expect(401);
    });

    it('S28 AS-29: a device is removed by its own id and only by its owner', async () => {
      const a = await t.newUser();
      const b = await t.newUser();
      const { body } = await register(a, {
        token: `tok-${v4()}`,
        platform: 'ios',
      }).expect(201);

      const foreign = await t
        .as(b)
        .delete(`/api/notifications/devices/${body.id}`)
        .expect(404);
      expect(foreign.body.code).toBe('device_not_found');
      expect(await listOf(a)).toHaveLength(1);

      const malformed = await t
        .as(a)
        .delete('/api/notifications/devices/not-a-uuid')
        .expect(400);
      expect(malformed.body.code).toBe('validation_failed');
      await t
        .http()
        .delete(`/api/notifications/devices/${body.id}`)
        .expect(401);

      await t.as(a).delete(`/api/notifications/devices/${body.id}`).expect(204);
      expect(await listOf(a)).toEqual([]);
      await t.as(a).delete(`/api/notifications/devices/${body.id}`).expect(404);
    });
  });
});
