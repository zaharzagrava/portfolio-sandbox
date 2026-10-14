import { ConfigRuleSet } from './config-rules';
import { auctionsConfigKeys, auctionsRule } from './auctions-config';

const run = (values: Record<string, unknown>, production = true) => {
  const set = new ConfigRuleSet();
  set.register({
    owner: 'auctions',
    keys: Object.keys(values),
    validate: auctionsRule,
  });
  return set.validate(values, { production });
};

const SECRET = 'a'.repeat(32);

const DEFAULTS: Array<[keyof typeof auctionsConfigKeys, number]> = [
  ['auctions_snipe_window_ms', 120_000],
  ['auctions_snipe_extension_ms', 120_000],
  ['auctions_snipe_cap_ms', 3_600_000],
  ['auctions_sweep_interval_s', 30],
  ['auctions_hold_deadline_s', 300],
  ['auctions_min_lead_s', 60],
  ['auctions_min_duration_s', 600],
  ['auctions_max_duration_s', 2_592_000],
  ['auctions_winner_window_h', 48],
  ['auctions_offer_window_h', 24],
  ['auctions_view_cache_ms', 1000],
  ['auctions_order_max_attempts', 8],
  ['auctions_max_amount_minor', 1_000_000_000_000],
  ['auctions_partition_months_ahead', 3],
];

describe('S21 FR-024, FR-038: auction configuration', () => {
  it.each(DEFAULTS)('S21 FR-038: %s defaults to %s', (key, fallback) => {
    expect(auctionsConfigKeys[key].postProcess?.(undefined)).toBe(fallback);
  });

  it('S21 FR-024: the defaults and a good secret are accepted', () => {
    expect(
      run({
        ...Object.fromEntries(DEFAULTS),
        auctions_alias_secret: SECRET,
      }),
    ).toEqual([]);
  });

  it('S21 FR-024: a missing key falls back to its default; a development run needs no secret', () => {
    expect(run({}, false)).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      'a cap below the extension',
      { auctions_snipe_cap_ms: 1000, auctions_snipe_extension_ms: 120_000 },
      'auctions_snipe_cap_ms must be at least auctions_snipe_extension_ms',
    ],
    [
      'a minimum duration at the maximum',
      { auctions_min_duration_s: 100, auctions_max_duration_s: 100 },
      'auctions_min_duration_s must be less than auctions_max_duration_s',
    ],
    [
      'a hold deadline that is not above the sweep interval',
      { auctions_hold_deadline_s: 30, auctions_sweep_interval_s: 30 },
      'auctions_hold_deadline_s must be above auctions_sweep_interval_s',
    ],
    [
      'an extension of 0',
      { auctions_snipe_extension_ms: 0 },
      'auctions_snipe_extension_ms must be above 0',
    ],
    [
      'a maximum amount beyond the safe integers',
      { auctions_max_amount_minor: Number.MAX_SAFE_INTEGER + 2 },
      'auctions_max_amount_minor must be a safe integer',
    ],
    [
      'a short secret',
      { auctions_alias_secret: 'short' },
      'auctions_alias_secret must be at least 32 bytes',
    ],
  ])('S21 FR-024: %s is refused at startup', (_name, values, message) => {
    const found = run({ ...values, auctions_alias_secret: SECRET, ...values });
    expect(found.join('\n')).toContain(message);
  });

  it('S21 FR-024: production refuses a missing secret and never prints a value', () => {
    const found = run({});
    expect(found.join('\n')).toContain('auctions_alias_secret is required');
    expect(
      run({ auctions_alias_secret: 'topsecret' }).join('\n'),
    ).not.toContain('topsecret');
  });
});
