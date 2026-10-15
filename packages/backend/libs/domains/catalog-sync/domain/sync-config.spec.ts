import {
  resolveSyncConfig,
  SYNC_DEFAULTS,
  type SyncConfigKey,
} from './sync-config';

const from = (values: Partial<Record<SyncConfigKey, number>>) =>
  resolveSyncConfig((key) => values[key]);

describe('offline sync settings', () => {
  it('S09 AS-37: nothing set gives the numbers of the spec', () => {
    expect(from({})).toEqual(SYNC_DEFAULTS);
    expect(SYNC_DEFAULTS).toMatchObject({
      maxOps: 500,
      bodyLimitBytes: 2 * 1024 * 1024,
      pushBudgetMs: 20_000,
      claimLeaseMs: 60_000,
      recoveryAfterMs: 5 * 60_000,
      clockDriftMs: 60_000,
      maxOpAgeMs: 30 * 86_400_000,
      retentionMs: 90 * 86_400_000,
    });
  });

  it('S09 AS-37: a key overrides only its own number', () => {
    expect(from({ offline_sync_push_budget_ms: 1_500 })).toEqual({
      ...SYNC_DEFAULTS,
      pushBudgetMs: 1_500,
    });
  });

  it.each([
    ['more operations than a push may carry', { offline_sync_max_ops: 501 }],
    [
      'a recovery age below the lease',
      { offline_sync_recovery_after_ms: 1_000 },
    ],
    [
      'retention not above the operation age (a replay must meet its record)',
      { offline_sync_retention_ms: 30 * 86_400_000 },
    ],
  ] as const)('S09 AS-21: %s fails startup', (_name, values) => {
    expect(() => from(values)).toThrow(/invalid offline sync settings/);
  });
});
