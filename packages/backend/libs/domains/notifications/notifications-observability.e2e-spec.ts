import { v4 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  PASSWORD_RESET_MAILER,
  type PasswordResetMailer,
} from '@app/domains/identity';
import { CallbackIntakeService } from './application/callback-intake.service';
import { SuppressionService } from './application/suppression.service';
import {
  capturingLogs,
  consume,
  consumeInvite,
  createNotificationsApp,
  envelope,
  orderPaidEnvelope,
  rawEnvelope,
  waitFor as waitForSoon,
  waitForQueueEmpty,
  type NotificationsTestApp,
} from './testing';

const waitFor: typeof waitForSoon = (probe, options = {}) =>
  waitForSoon(probe, { timeoutMs: 45_000, ...options });

const PHONE = '+380501234567';

/** The metrics of contracts/services.md "Metrics", with the label names each may carry (AS-86). */
const METRICS: Record<
  string,
  { kind: 'counter' | 'gauge' | 'histogram'; labels: string[] }
> = {
  notifications_events_consumed_total: {
    kind: 'counter',
    labels: ['type', 'outcome'],
  },
  notifications_events_ignored_total: { kind: 'counter', labels: ['reason'] },
  notifications_dead_letter_total: {
    kind: 'counter',
    labels: ['source', 'reason'],
  },
  notifications_inbox_created_total: { kind: 'counter', labels: ['category'] },
  notifications_delivery_total: {
    kind: 'counter',
    labels: ['channel', 'line', 'status'],
  },
  notifications_delivery_attempt_total: {
    kind: 'counter',
    labels: ['channel', 'outcome'],
  },
  notifications_failover_total: { kind: 'counter', labels: ['channel'] },
  notifications_provider_circuit_state: { kind: 'gauge', labels: ['provider'] },
  notifications_capped_total: { kind: 'counter', labels: ['channel'] },
  notifications_quiet_delayed_total: { kind: 'counter', labels: ['channel'] },
  notifications_expired_total: { kind: 'counter', labels: ['type'] },
  notifications_stale_version_dropped_total: {
    kind: 'counter',
    labels: ['family'],
  },
  notifications_realtime_publish_failed_total: { kind: 'counter', labels: [] },
  notifications_unread_rebuilt_total: { kind: 'counter', labels: [] },
  notifications_callbacks_total: {
    kind: 'counter',
    labels: ['provider', 'outcome'],
  },
  notifications_suppressed_total: {
    kind: 'counter',
    labels: ['channel', 'reason'],
  },
  notifications_timezone_fallback_total: { kind: 'counter', labels: [] },
  notifications_delivery_latency_seconds: {
    kind: 'histogram',
    labels: ['channel', 'line'],
  },
};

describe('Notifications: logs and metrics', () => {
  let t: NotificationsTestApp;
  const front = () =>
    t.app.get(ApiConfigService).get('front_host').replace(/\/$/, '');
  const metric = (name: string, labels: Record<string, string> = {}) =>
    MetricsRegistry.value(name, labels) ?? 0;

  beforeAll(async () => {
    t = await createNotificationsApp({ env: { EMAIL_PROVIDER: 'memory' } });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => t.reset());

  it('S28 AS-85: a full flow (order, invitation, reset, phone code, unsubscribe link, complaint) leaves no contact data, secret or message text in the logs', async () => {
    const buyer = await t.newUser();
    const owner = await t.newUser();
    const { shopId } = await t.seedShop([owner.id]);
    const pushToken = `push-token-${v4()}`;
    await t
      .as(buyer)
      .post('/api/notifications/devices')
      .send({ token: pushToken, platform: 'ios' })
      .expect((res) => expect([200, 201]).toContain(res.status));

    const resetToken = `RESET-${v4()}`;
    const inviteToken = `INVITE-${v4()}`;
    const inviteeEmail = `invitee-${v4()}@example.com`;
    const complainedEmail = `complained-${v4()}@example.com`;
    const previousFlag = process.env.DEV_MAILBOX_ENABLED;
    process.env.DEV_MAILBOX_ENABLED = 'true';
    try {
      const { logged } = await capturingLogs(async () => {
        // AS-21: a phone number and its code
        await t
          .as(buyer)
          .put('/api/notifications/settings')
          .send({ phone: PHONE });
        // AS-01: an order paid
        await consume(t, [
          orderPaidEnvelope({
            userId: buyer.id,
            shops: [{ shopId, subtotalMinor: 12_990 }],
          }),
        ]);
        // AS-09: the reset link
        await t.app
          .get<PasswordResetMailer>(PASSWORD_RESET_MAILER)
          .sendResetLink({
            to: buyer.email,
            link: `${front()}/reset-password#token=${resetToken}`,
            expiresAt: new Date(t.clock.now().getTime() + 30 * 60_000),
          });
        // AS-08: an invitation, and a malformed one
        const invite = {
          inviteId: v4(),
          shopId,
          shopName: 'Fox & Co',
          email: inviteeEmail,
          role: 'STAFF',
          token: inviteToken,
          expiresAt: t.clock.now().toISOString(),
          invitedBy: owner.id,
        };
        await consumeInvite(t, invite, 'msg-good');
        await consumeInvite(t, { ...invite, email: undefined }, 'msg-bad');
        // a provider complaint for an unknown delivery
        await t.app.get(CallbackIntakeService).acceptSes(
          v4(),
          JSON.stringify({
            eventType: 'Complaint',
            mail: { messageId: 'ses-unknown' },
            complaint: {
              complainedRecipients: [{ emailAddress: complainedEmail }],
            },
          }),
        );
        await waitFor(
          async () => t.providers.email.callsTo(buyer.email).length >= 1,
        );
        await waitFor(
          async () => t.providers.email.callsTo(inviteeEmail).length >= 1,
        );
        await waitFor(
          async () => t.providers.push.callsTo(pushToken).length >= 1,
        );
        await waitFor(() =>
          t.app.get(SuppressionService).isSuppressed('email', complainedEmail),
        );
        await waitForQueueEmpty(t, 'notify-email');
        await waitForQueueEmpty(t, 'notify-push');
      });

      const confirmation = t.providers.email
        .callsTo(buyer.email)
        .find((m) => m.type === 'order.confirmed');
      expect(confirmation).toBeDefined();
      const unsubscribeToken = new URL(
        confirmation!.unsubscribeUrl!,
      ).searchParams.get('token')!;
      const code = /\b(\d{6})\b/.exec(
        t.providers.sms.callsTo(PHONE)[0]?.body ?? '',
      )?.[1];
      expect(code).toBeDefined();

      const forbidden: Array<[string, string]> = [
        ['buyer e-mail', buyer.email],
        ['owner e-mail', owner.email],
        ['invitee e-mail', inviteeEmail],
        ['complained e-mail', complainedEmail],
        ['phone number', PHONE],
        ['push token', pushToken],
        ['reset token', resetToken],
        ['invite token', inviteToken],
        ['unsubscribe token', unsubscribeToken],
        ['message subject', confirmation!.subject],
        ['message body', confirmation!.body],
      ];
      for (const [what, secret] of forbidden)
        expect({ what, leaked: logged.includes(secret) }).toEqual({
          what,
          leaked: false,
        });
      expect({
        what: 'phone code',
        leaked: new RegExp(`\\b${code}\\b`).test(logged),
      }).toEqual({
        what: 'phone code',
        leaked: false,
      });
      // The lines the operations contract promises, with ids only.
      expect(logged).toMatch(
        new RegExp(
          `notifications\\.event\\.routed userId=${buyer.id} type=order\\.confirmed`,
        ),
      );
      expect(logged).toMatch(
        new RegExp(
          `notifications\\.delivery\\.sent userId=${buyer.id} type=order\\.confirmed channel=email deliveryId=\\S+`,
        ),
      );
    } finally {
      if (previousFlag === undefined) delete process.env.DEV_MAILBOX_ENABLED;
      else process.env.DEV_MAILBOX_ENABLED = previousFlag;
    }
  });

  it('S28 AS-85: a permanent provider refusal that quotes the address is logged and recorded without it', async () => {
    const user = await t.newUser();
    t.providers.email.failPermanently(
      [user.email],
      `550 mailbox ${user.email} unavailable`,
    );
    const { logged } = await capturingLogs(async () => {
      await consume(t, [orderPaidEnvelope({ userId: user.id })]);
      await waitFor(
        async () =>
          metric('notifications_delivery_total', {
            channel: 'email',
            line: 'transactional',
            status: 'failed',
          }) >= 1,
      );
    });
    expect(logged).not.toContain(user.email);
    expect(logged).toMatch(
      /notifications\.delivery\.failed userId=\S+ type=order\.confirmed channel=email deliveryId=\S+ reason=permanent/,
    );
  });

  it('S28 AS-86: every metric of the contract is registered with its fixed name and labels', () => {
    for (const [name, { kind, labels }] of Object.entries(METRICS)) {
      // Registering the same name with other labels is refused exactly when it already exists with these.
      const probe = () => {
        const def = { name, help: 'probe', labels: [...labels, 'probe'] };
        if (kind === 'counter') MetricsRegistry.counter(def);
        else if (kind === 'gauge') MetricsRegistry.gauge(def);
        else MetricsRegistry.histogram({ ...def, buckets: [1] });
      };
      expect({
        name,
        registered: (() => {
          try {
            probe();
            return false;
          } catch (e) {
            return /already registered/.test((e as Error).message);
          }
        })(),
      }).toEqual({ name, registered: true });
    }
  });

  it('S28 AS-86: the flows move the counters and histograms, and no label carries an id or an address', async () => {
    const user = await t.newUser();
    const consumed = metric('notifications_events_consumed_total', {
      type: 'order.paid',
      outcome: 'mapped',
    });
    const ignoredBefore = metric('notifications_events_ignored_total', {
      reason: 'unmapped',
    });
    const created = metric('notifications_inbox_created_total', {
      category: 'orders',
    });
    const sent = metric('notifications_delivery_total', {
      channel: 'email',
      line: 'transactional',
      status: 'sent',
    });
    const latency =
      MetricsRegistry.histogramValue('notifications_delivery_latency_seconds', {
        channel: 'email',
        line: 'transactional',
      })?.count ?? 0;

    await consume(t, [orderPaidEnvelope({ userId: user.id })]);
    await consume(
      t,
      [rawEnvelope('identity.something_new', { userId: user.id })],
      { family: 'identity' },
    );
    await consume(t, [
      envelope('identity.user_registered', { userId: user.id }),
    ]);
    await waitFor(
      async () =>
        metric('notifications_delivery_total', {
          channel: 'email',
          line: 'transactional',
          status: 'sent',
        }) > sent,
    );

    expect(
      metric('notifications_events_consumed_total', {
        type: 'order.paid',
        outcome: 'mapped',
      }),
    ).toBe(consumed + 1);
    expect(
      metric('notifications_events_ignored_total', { reason: 'unmapped' }),
    ).toBe(ignoredBefore + 1);
    expect(
      metric('notifications_inbox_created_total', { category: 'orders' }),
    ).toBe(created + 1);
    expect(
      metric('notifications_delivery_attempt_total', {
        channel: 'email',
        outcome: 'sent',
      }),
    ).toBeGreaterThan(0);
    expect(
      MetricsRegistry.histogramValue('notifications_delivery_latency_seconds', {
        channel: 'email',
        line: 'transactional',
      })!.count,
    ).toBeGreaterThan(latency);

    for (const [name, { labels }] of Object.entries(METRICS))
      for (const set of MetricsRegistry.labelSets(name))
        for (const [key, value] of Object.entries(set)) {
          expect([...labels, 'overflow']).toContain(key);
          expect(String(value)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
          expect(String(value)).not.toContain('@');
          expect(String(value)).not.toContain(user.id);
        }
  });
});
