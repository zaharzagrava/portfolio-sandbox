import { NOTIFICATION_TYPES, typeDef } from './catalog';
import type { NotificationTypeDef } from './catalog';
import { resolveChannels, unreachableDefaults } from './channel-resolution';

const view = (over: Partial<Parameters<typeof resolveChannels>[1]> = {}) => ({
  email: 'a@example.com',
  phone: null as string | null,
  phoneVerified: false,
  devices: [{ id: 'd1', token: 't', platform: 'ios' as const }],
  overrides: {} as Record<string, boolean>,
  ...over,
});

describe('S28 AS-06: channel resolution', () => {
  const confirmed = typeDef('order.confirmed');

  it('S28 AS-06: defaults, then the explicit overrides of the user', () => {
    expect(resolveChannels(confirmed, view())).toEqual([
      'email',
      'push',
      'inapp',
    ]);
    expect(
      resolveChannels(
        confirmed,
        view({ overrides: { 'orders:email': false } }),
      ),
    ).toEqual(['push', 'inapp']);
  });

  it('S28 AS-06: a channel the user cannot be reached on is dropped, the inbox stays', () => {
    const none = view({ email: null, devices: [] });
    expect(resolveChannels(confirmed, none)).toEqual(['inapp']);
    expect(unreachableDefaults(confirmed, none)).toEqual(['email', 'push']);
  });

  it('S28 AS-06: SMS is off by default and needs a verified phone when switched on', () => {
    const on = { 'orders:sms': true };
    expect(resolveChannels(confirmed, view({ overrides: on }))).not.toContain(
      'sms',
    );
    expect(
      resolveChannels(
        confirmed,
        view({ overrides: on, phone: '+380501112233', phoneVerified: false }),
      ),
    ).not.toContain('sms');
    expect(
      resolveChannels(
        confirmed,
        view({ overrides: on, phone: '+380501112233', phoneVerified: true }),
      ),
    ).toContain('sms');
  });

  it('S28 AS-17: a mandatory type ignores opt-outs on its default channels', () => {
    const failed = typeDef('billing.payment_failed');
    expect(
      resolveChannels(
        failed,
        view({
          overrides: { 'billing:email': false, 'billing:inapp': false },
        }),
      ),
    ).toEqual(['email', 'inapp']);
  });

  it('S28 AS-14: marketing external channels are off unless switched on; the inbox default holds', () => {
    const update = typeDef('marketing.followed_shop_update');
    expect(resolveChannels(update, view())).toEqual(['inapp']);
    expect(
      resolveChannels(update, view({ overrides: { 'marketing:push': true } })),
    ).toEqual(['push', 'inapp']);
    expect(
      resolveChannels(
        update,
        view({ overrides: { 'marketing:inapp': false } }),
      ),
    ).toEqual([]);
  });

  it('S28 AS-87: every catalog type resolves to its default channels for a fully reachable user', () => {
    const reachable = view({ phone: '+380501112233', phoneVerified: true });
    for (const def of Object.values(
      NOTIFICATION_TYPES,
    ) as NotificationTypeDef[])
      expect(resolveChannels(def, reachable)).toEqual(
        def.channels.filter((c) => c !== 'sms' || def.mandatory),
      );
  });
});
