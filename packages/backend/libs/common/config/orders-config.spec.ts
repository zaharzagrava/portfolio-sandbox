import { ConfigRuleSet } from './config-rules';
import { ordersConfigKeys, ordersFlashRule } from './orders-config';

const run = (values: Record<string, unknown>) => {
  const set = new ConfigRuleSet();
  set.register({
    owner: 'orders',
    keys: Object.keys(values),
    validate: ordersFlashRule,
  });
  return set.validate(values, { production: true });
};

const FLASH_DEFAULTS: Array<[keyof typeof ordersConfigKeys, number]> = [
  ['orders_flash_load_lead_seconds', 60],
  ['orders_flash_min_lead_seconds', 120],
  ['orders_flash_max_window_seconds', 86_400],
  ['orders_flash_claim_window_seconds', 60],
  ['orders_flash_order_margin_seconds', 20],
  ['orders_flash_verify_interval_seconds', 30],
  ['orders_flash_sweep_interval_seconds', 10],
  ['orders_flash_call_timeout_ms', 100],
  ['orders_flash_public_cache_ms', 1000],
  ['orders_flash_reconcile_wait_alert_seconds', 600],
  ['orders_flash_key_ttl_jitter', 0.1],
];

describe('S11 R-12: flash-sale configuration', () => {
  it.each(FLASH_DEFAULTS)('%s defaults to %s', (key, fallback) => {
    const entry = ordersConfigKeys[key];
    expect(entry.postProcess?.(undefined)).toBe(fallback);
  });

  it('accepts the defaults', () => {
    expect(
      run(Object.fromEntries(FLASH_DEFAULTS.map(([k, v]) => [k, v]))),
    ).toEqual([]);
  });

  it('accepts an empty configuration (defaults apply)', () => {
    expect(run({})).toEqual([]);
  });

  it.each([
    [
      'margin equal to the claim window',
      {
        orders_flash_order_margin_seconds: 60,
        orders_flash_claim_window_seconds: 60,
      },
      'orders_flash_order_margin_seconds must be less than orders_flash_claim_window_seconds',
    ],
    [
      'load lead equal to the minimum lead',
      {
        orders_flash_load_lead_seconds: 120,
        orders_flash_min_lead_seconds: 120,
      },
      'orders_flash_load_lead_seconds must be less than orders_flash_min_lead_seconds',
    ],
    [
      'a call timeout above 1000 ms',
      { orders_flash_call_timeout_ms: 1001 },
      'orders_flash_call_timeout_ms must be at most 1000',
    ],
    [
      'a jitter of 1 or more',
      { orders_flash_key_ttl_jitter: 1 },
      'orders_flash_key_ttl_jitter must be below 1',
    ],
  ])('refuses %s', (_name, change, expected) => {
    const found = run(change);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(expected);
  });

  it('accepts a call timeout of exactly 1000 ms', () => {
    expect(run({ orders_flash_call_timeout_ms: 1000 })).toEqual([]);
  });
});
