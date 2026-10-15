import { ConfigRuleSet } from './config-rules';
import {
  payoutConfigKeys,
  payoutLimitsRule,
  payoutSecretsRule,
} from './payout-config';

const SECRET = 'a-payout-cursor-secret-of-at-least-32-bytes';

const defaultOf = (key: keyof typeof payoutConfigKeys): number =>
  (payoutConfigKeys[key].postProcess as (v: unknown) => number)(undefined);

describe('payout config (S15 AS-54)', () => {
  it('S15 AS-54: defaults are the values of the spec', () => {
    expect(defaultOf('payout_default_reserve_bps')).toBe(1000);
    expect(defaultOf('payout_min_minor')).toBe(1000);
    expect(defaultOf('payout_cap_minor')).toBe(5_000_000);
    expect(defaultOf('payout_destination_cooling_hours')).toBe(48);
    expect(defaultOf('payout_provider_timeout_ms')).toBe(10_000);
    expect(defaultOf('payout_send_max_attempts')).toBe(5);
    expect(defaultOf('payout_resolver_max_resends')).toBe(3);
    expect(defaultOf('payout_stale_sending_ms')).toBe(300_000);
    expect(defaultOf('payout_in_doubt_after_hours')).toBe(24);
  });

  it.each([
    [
      'payout_default_reserve_bps',
      'PAYOUT_DEFAULT_RESERVE_BPS',
      [-1, 5001, 12.5, 'x'],
    ],
    ['payout_min_minor', 'PAYOUT_MIN_MINOR', [0, -5, 1.5]],
    ['payout_cap_minor', 'PAYOUT_CAP_MINOR', [0, 'many']],
    [
      'payout_destination_cooling_hours',
      'PAYOUT_DESTINATION_COOLING_HOURS',
      [-1, 0.5],
    ],
    ['payout_provider_timeout_ms', 'PAYOUT_PROVIDER_TIMEOUT_MS', [0, -1]],
    ['payout_send_max_attempts', 'PAYOUT_SEND_MAX_ATTEMPTS', [0, 11]],
    ['payout_resolver_max_resends', 'PAYOUT_RESOLVER_MAX_RESENDS', [-1, 11]],
    ['payout_stale_sending_ms', 'PAYOUT_STALE_SENDING_MS', [0, -1]],
    ['payout_in_doubt_after_hours', 'PAYOUT_IN_DOUBT_AFTER_HOURS', [0, -2]],
  ] as const)(
    'S15 AS-54: an invalid %s fails naming %s',
    (key, variable, bad) => {
      const entry = payoutConfigKeys[key];
      expect(entry.name).toBe(variable);
      for (const value of bad)
        expect(entry.verify.validate(value).error).toBeDefined();
    },
  );

  it('S15 AS-54: valid boundary values are accepted', () => {
    expect(
      payoutConfigKeys.payout_default_reserve_bps.verify.validate(0).error,
    ).toBeUndefined();
    expect(
      payoutConfigKeys.payout_default_reserve_bps.verify.validate(5000).error,
    ).toBeUndefined();
    expect(
      payoutConfigKeys.payout_send_max_attempts.verify.validate(10).error,
    ).toBeUndefined();
  });

  const limits = (values: Record<string, unknown>) =>
    payoutLimitsRule({ get: (k: string) => values[k], production: false });

  it('S15 AS-54: the cap may not be under the minimum, and the message names both keys', () => {
    expect(limits({ payout_min_minor: 2000, payout_cap_minor: 1000 })).toEqual([
      'payout_cap_minor must be at least payout_min_minor',
    ]);
    expect(limits({ payout_min_minor: 1000, payout_cap_minor: 1000 })).toEqual(
      [],
    );
    // defaults still apply when only one side is set
    expect(limits({ payout_min_minor: 6_000_000 })).toEqual([
      'payout_cap_minor must be at least payout_min_minor',
    ]);
  });

  const secrets = (values: Record<string, unknown>, production = false) =>
    payoutSecretsRule({ get: (k: string) => values[k], production });

  it('S15 AS-54: the cursor secret is at least 32 bytes, differs from the session secret, and no message holds a value', () => {
    expect(secrets({ payout_cursor_secret: 'short' })).toEqual([
      'payout_cursor_secret must be at least 32 bytes',
    ]);
    const same = secrets({ payout_cursor_secret: SECRET, jwt_secret: SECRET });
    expect(same).toEqual(['payout_cursor_secret must differ from jwt_secret']);
    expect(JSON.stringify(same)).not.toContain(SECRET);
    expect(
      secrets({ payout_cursor_secret: SECRET, jwt_secret: 'other' }),
    ).toEqual([]);
  });

  it('S15 AS-54: a production start without a cursor secret falls back to the ledger secret rule, else fails', () => {
    expect(secrets({}, true)).toEqual(['payout_cursor_secret is required']);
    expect(secrets({ ledger_cursor_secret: SECRET }, true)).toEqual([]);
    expect(secrets({}, false)).toEqual([]);
  });

  it('S15 AS-54: the rules are registered under the owner payouts and prefix the key', () => {
    const set = new ConfigRuleSet();
    set.register({
      owner: 'payouts',
      keys: [],
      validate: payoutLimitsRule,
    });
    expect(
      set.validate(
        { payout_min_minor: 5, payout_cap_minor: 1 },
        { production: false },
      ),
    ).toEqual(['[payouts] payout_cap_minor must be at least payout_min_minor']);
  });
});
