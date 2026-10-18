import {
  DEFAULT_WEBHOOK_SETTINGS,
  resolveWebhookSettings,
  validateWebhookSettings,
  WebhookSettings,
  WebhookSettingsError,
} from './webhook-settings';

const MIN = 60_000;
const settings = (over: Partial<WebhookSettings> = {}): WebhookSettings => ({
  ...DEFAULT_WEBHOOK_SETTINGS,
  ...over,
});

const failure = (s: WebhookSettings, nodeEnv: string): WebhookSettingsError => {
  try {
    validateWebhookSettings(s, { nodeEnv });
  } catch (e) {
    expect(e).toBeInstanceOf(WebhookSettingsError);
    return e as WebhookSettingsError;
  }
  throw new Error('expected validation to fail');
};

describe('webhook settings (pure)', () => {
  it('S43 AS-71: the defaults are the numbers of the spec and are valid in production', () => {
    expect(DEFAULT_WEBHOOK_SETTINGS).toMatchObject({
      attemptTimeoutMs: 10_000,
      responseReadCapBytes: 1024,
      bodyCapBytes: 256 * 1024,
      laneAttempts: 3,
      laneDelayMs: 30_000,
      jitter: 0.2,
      breakerFailureThreshold: 5,
      breakerBaseOpenMs: MIN,
      breakerMaxOpenMs: 30 * MIN,
      failureWindowMs: 3 * 24 * 60 * MIN,
      logTtlDays: 30,
      historyRetentionDays: 400,
      privateHostAllowance: [],
    });
    expect(DEFAULT_WEBHOOK_SETTINGS.retryDelaysMs).toEqual(
      [5, 30, 120, 300, 600, 1440, 1440, 1440].map((m) => m * MIN),
    );
    expect(() =>
      validateWebhookSettings(DEFAULT_WEBHOOK_SETTINGS, {
        nodeEnv: 'production',
      }),
    ).not.toThrow();
  });

  it('S43 AS-71: a private-host allowance in production fails startup and names the setting', () => {
    const e = failure(
      settings({ privateHostAllowance: ['hooks.local'] }),
      'production',
    );
    expect(e.setting).toBe('privateHostAllowance');
    expect(e.message).toMatch(/privateHostAllowance/);
  });

  it('S43 G-32: allowed receiver hosts are empty by default and refused in production, naming the setting', () => {
    expect(DEFAULT_WEBHOOK_SETTINGS.allowedReceiverHosts).toEqual([]);
    const e = failure(
      settings({ allowedReceiverHosts: ['127.0.0.1:18443'] }),
      'production',
    );
    expect(e.setting).toBe('allowedReceiverHosts');
    expect(() =>
      validateWebhookSettings(
        settings({ allowedReceiverHosts: ['127.0.0.1:18443'] }),
        { nodeEnv: 'test' },
      ),
    ).not.toThrow();
  });

  it('S43 G-32: allowed receiver hosts are parsed from a comma list and must be host:port', () => {
    expect(
      resolveWebhookSettings(
        { allowedReceiverHosts: '127.0.0.1:18443, receiver.test:9443' },
        { nodeEnv: 'test' },
      ).allowedReceiverHosts,
    ).toEqual(['127.0.0.1:18443', 'receiver.test:9443']);
    expect(() =>
      resolveWebhookSettings(
        { allowedReceiverHosts: 'receiver.test' },
        { nodeEnv: 'test' },
      ),
    ).toThrow(/allowedReceiverHosts/);
  });

  it.each(['test', 'development', 'staging'])(
    'S43 AS-71: outside production (%s) the allowance is honoured for the listed hosts only',
    (nodeEnv) => {
      const s = settings({ privateHostAllowance: ['hooks.local'] });
      expect(() => validateWebhookSettings(s, { nodeEnv })).not.toThrow();
      expect(s.privateHostAllowance).toEqual(['hooks.local']);
    },
  );

  it.each<[string, Partial<WebhookSettings>, string]>([
    [
      'a schedule that goes down',
      { retryDelaysMs: [5 * MIN, 2 * MIN] },
      'retryDelaysMs',
    ],
    ['an empty schedule', { retryDelaysMs: [] }, 'retryDelaysMs'],
    ['a zero delay', { retryDelaysMs: [0, MIN] }, 'retryDelaysMs'],
    ['jitter below 0', { jitter: -0.01 }, 'jitter'],
    ['jitter above 0.5', { jitter: 0.51 }, 'jitter'],
    ['jitter not a number', { jitter: Number.NaN }, 'jitter'],
    ['a zero attempt timeout', { attemptTimeoutMs: 0 }, 'attemptTimeoutMs'],
    [
      'a negative attempt timeout',
      { attemptTimeoutMs: -1 },
      'attemptTimeoutMs',
    ],
    ['a zero read cap', { responseReadCapBytes: 0 }, 'responseReadCapBytes'],
    ['a zero body cap', { bodyCapBytes: 0 }, 'bodyCapBytes'],
    ['a zero lane delay', { laneDelayMs: 0 }, 'laneDelayMs'],
    [
      'a zero visibility timeout',
      { visibilityTimeoutSec: 0 },
      'visibilityTimeoutSec',
    ],
    [
      'a zero worker concurrency',
      { workerConcurrency: 0 },
      'workerConcurrency',
    ],
    [
      'a breaker that closes sooner than it opens',
      { breakerBaseOpenMs: 10 * MIN, breakerMaxOpenMs: MIN },
      'breakerMaxOpenMs',
    ],
    [
      'no failure threshold',
      { breakerFailureThreshold: 0 },
      'breakerFailureThreshold',
    ],
    ['a zero failure window', { failureWindowMs: 0 }, 'failureWindowMs'],
    [
      'a message that becomes visible before the attempt deadline',
      { visibilityTimeoutSec: 10 },
      'visibilityTimeoutSec',
    ],
  ])(
    'S43 AS-71: %s fails startup naming %s (production and development alike)',
    (_name, over, setting) => {
      for (const env of ['production', 'test'])
        expect(failure(settings(over), env).setting).toBe(setting);
    },
  );

  it('S43 AS-71: equal delays are allowed (the schedule is non-decreasing, not strictly increasing)', () => {
    expect(() =>
      validateWebhookSettings(
        settings({ retryDelaysMs: [MIN, MIN, 2 * MIN] }),
        { nodeEnv: 'production' },
      ),
    ).not.toThrow();
  });

  it('S43 AS-71: jitter at the bounds 0 and 0.5 is valid', () => {
    for (const jitter of [0, 0.5])
      expect(() =>
        validateWebhookSettings(settings({ jitter }), {
          nodeEnv: 'production',
        }),
      ).not.toThrow();
  });

  describe('resolve from raw configuration', () => {
    it('S43 AS-71: unset keys take the defaults', () => {
      expect(resolveWebhookSettings({}, { nodeEnv: 'production' })).toEqual(
        DEFAULT_WEBHOOK_SETTINGS,
      );
    });

    it('S43 AS-71: overrides replace defaults and are validated', () => {
      const s = resolveWebhookSettings(
        {
          attemptTimeoutMs: 5000,
          workerConcurrency: 10,
          privateHostAllowance: 'a.local, b.local',
        },
        { nodeEnv: 'test' },
      );
      expect(s).toMatchObject({
        attemptTimeoutMs: 5000,
        workerConcurrency: 10,
        privateHostAllowance: ['a.local', 'b.local'],
      });
      expect(() =>
        resolveWebhookSettings(
          { privateHostAllowance: 'a.local' },
          { nodeEnv: 'production' },
        ),
      ).toThrow(/privateHostAllowance/);
      expect(() =>
        resolveWebhookSettings({ jitter: 0.9 }, { nodeEnv: 'test' }),
      ).toThrow(/jitter/);
    });

    it('S43 AS-71: the retry schedule may be given as comma-separated minutes', () => {
      const s = resolveWebhookSettings(
        { retryDelaysMinutes: '1,2,4' },
        { nodeEnv: 'test' },
      );
      expect(s.retryDelaysMs).toEqual([MIN, 2 * MIN, 4 * MIN]);
    });

    it('S43 AS-71: a value that is not a number fails naming the setting', () => {
      expect(() =>
        resolveWebhookSettings(
          { attemptTimeoutMs: 'soon' },
          { nodeEnv: 'test' },
        ),
      ).toThrow(/attemptTimeoutMs/);
    });
  });
});
