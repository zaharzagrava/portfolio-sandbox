/**
 * Webhook configuration (S43 FR-032, FR-041, AS-71): every number of the spec is configuration, validated once at
 * startup by each hosting module. Pure: the environment name and the raw values are passed in.
 */
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Injection token of the validated settings (provided by `infra/webhook-settings.provider.ts`). */
export const WEBHOOK_SETTINGS = Symbol('WEBHOOK_SETTINGS');

export interface WebhookSettings {
  /** Overall deadline of one attempt (10 s). */
  attemptTimeoutMs: number;
  /** Bytes of the receiver's answer that are read (1 KiB). */
  responseReadCapBytes: number;
  /** Largest rendered body that is sent (256 KiB). */
  bodyCapBytes: number;
  laneAttempts: number;
  laneDelayMs: number;
  retryDelaysMs: number[];
  jitter: number;
  maxRetryDelayMs: number;
  breakerFailureThreshold: number;
  breakerBaseOpenMs: number;
  breakerMaxOpenMs: number;
  breakerProbeWaitMs: number;
  /** Continuous failure after which an endpoint is switched off (3 d). */
  failureWindowMs: number;
  /** Queue message invisibility; must exceed the attempt deadline. */
  visibilityTimeoutSec: number;
  workerConcurrency: number;
  /** Cache bound for subscription reads (<= 5 s, FR-028). */
  subscriptionCacheTtlMs: number;
  logTtlDays: number;
  historyRetentionDays: number;
  /** Hosts that may resolve to private addresses; honoured outside production only. */
  privateHostAllowance: string[];
}

export const DEFAULT_WEBHOOK_SETTINGS: WebhookSettings = {
  attemptTimeoutMs: 10_000,
  responseReadCapBytes: 1024,
  bodyCapBytes: 256 * 1024,
  laneAttempts: 3,
  laneDelayMs: 30_000,
  retryDelaysMs: [5, 30, 120, 300, 600, 1440, 1440, 1440].map((m) => m * MIN),
  jitter: 0.2,
  maxRetryDelayMs: DAY,
  breakerFailureThreshold: 5,
  breakerBaseOpenMs: MIN,
  breakerMaxOpenMs: 30 * MIN,
  breakerProbeWaitMs: 10_000,
  failureWindowMs: 3 * DAY,
  visibilityTimeoutSec: 30,
  workerConcurrency: 50,
  subscriptionCacheTtlMs: 5_000,
  logTtlDays: 30,
  historyRetentionDays: 400,
  privateHostAllowance: [],
};

/** Startup failure that names the setting. */
export class WebhookSettingsError extends Error {
  constructor(
    readonly setting: keyof WebhookSettings,
    reason: string,
  ) {
    super(`webhook setting "${setting}" ${reason}`);
    this.name = 'WebhookSettingsError';
  }
}

const positive = (s: WebhookSettings, key: keyof WebhookSettings): void => {
  const v = s[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
    throw new WebhookSettingsError(key, 'must be a positive number');
};

/** Throws a `WebhookSettingsError` for the first broken rule; returns the settings for chaining. */
export function validateWebhookSettings(
  s: WebhookSettings,
  env: { nodeEnv: string | undefined },
): WebhookSettings {
  if (env.nodeEnv === 'production' && s.privateHostAllowance.length > 0)
    throw new WebhookSettingsError(
      'privateHostAllowance',
      'must be empty in production',
    );
  for (const key of [
    'attemptTimeoutMs',
    'responseReadCapBytes',
    'bodyCapBytes',
    'laneAttempts',
    'laneDelayMs',
    'maxRetryDelayMs',
    'breakerFailureThreshold',
    'breakerBaseOpenMs',
    'breakerMaxOpenMs',
    'breakerProbeWaitMs',
    'failureWindowMs',
    'visibilityTimeoutSec',
    'workerConcurrency',
    'subscriptionCacheTtlMs',
    'logTtlDays',
    'historyRetentionDays',
  ] as const)
    positive(s, key);
  if (
    s.retryDelaysMs.length === 0 ||
    s.retryDelaysMs.some((d) => !Number.isFinite(d) || d <= 0) ||
    s.retryDelaysMs.some((d, i) => i > 0 && d < s.retryDelaysMs[i - 1])
  )
    throw new WebhookSettingsError(
      'retryDelaysMs',
      'must be a non-empty, non-decreasing list of positive delays',
    );
  if (!Number.isFinite(s.jitter) || s.jitter < 0 || s.jitter > 0.5)
    throw new WebhookSettingsError('jitter', 'must be between 0 and 0.5');
  if (s.breakerMaxOpenMs < s.breakerBaseOpenMs)
    throw new WebhookSettingsError(
      'breakerMaxOpenMs',
      'must not be below breakerBaseOpenMs',
    );
  if (s.visibilityTimeoutSec * 1000 <= s.attemptTimeoutMs)
    throw new WebhookSettingsError(
      'visibilityTimeoutSec',
      'must exceed the attempt deadline so a slow attempt is not duplicated',
    );
  return s;
}

type Raw = Record<string, unknown>;

const num = (
  raw: Raw,
  key: keyof WebhookSettings,
  fallback: number,
): number => {
  const v = raw[key];
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n))
    throw new WebhookSettingsError(key, 'must be a number');
  return n;
};

/**
 * Settings from raw configuration values (strings or numbers); unset keys take the defaults. The retry schedule is
 * `retryDelaysMinutes` ("5,30,120"), the allowance `privateHostAllowance` ("a.local,b.local").
 */
export function resolveWebhookSettings(
  raw: Raw,
  env: { nodeEnv: string | undefined },
): WebhookSettings {
  const d = DEFAULT_WEBHOOK_SETTINGS;
  const list = (v: unknown): string[] =>
    (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const delays =
    raw.retryDelaysMinutes !== undefined && raw.retryDelaysMinutes !== ''
      ? list(raw.retryDelaysMinutes).map((m) => Number(m) * MIN)
      : d.retryDelaysMs;
  if (delays.some((x) => Number.isNaN(x)))
    throw new WebhookSettingsError(
      'retryDelaysMs',
      'must be numbers of minutes',
    );
  const settings: WebhookSettings = {
    attemptTimeoutMs: num(raw, 'attemptTimeoutMs', d.attemptTimeoutMs),
    responseReadCapBytes: num(
      raw,
      'responseReadCapBytes',
      d.responseReadCapBytes,
    ),
    bodyCapBytes: num(raw, 'bodyCapBytes', d.bodyCapBytes),
    laneAttempts: num(raw, 'laneAttempts', d.laneAttempts),
    laneDelayMs: num(raw, 'laneDelayMs', d.laneDelayMs),
    retryDelaysMs: delays,
    jitter: num(raw, 'jitter', d.jitter),
    maxRetryDelayMs: num(raw, 'maxRetryDelayMs', d.maxRetryDelayMs),
    breakerFailureThreshold: num(
      raw,
      'breakerFailureThreshold',
      d.breakerFailureThreshold,
    ),
    breakerBaseOpenMs: num(raw, 'breakerBaseOpenMs', d.breakerBaseOpenMs),
    breakerMaxOpenMs: num(raw, 'breakerMaxOpenMs', d.breakerMaxOpenMs),
    breakerProbeWaitMs: num(raw, 'breakerProbeWaitMs', d.breakerProbeWaitMs),
    failureWindowMs: num(raw, 'failureWindowMs', d.failureWindowMs),
    visibilityTimeoutSec: num(
      raw,
      'visibilityTimeoutSec',
      d.visibilityTimeoutSec,
    ),
    workerConcurrency: num(raw, 'workerConcurrency', d.workerConcurrency),
    subscriptionCacheTtlMs: num(
      raw,
      'subscriptionCacheTtlMs',
      d.subscriptionCacheTtlMs,
    ),
    logTtlDays: num(raw, 'logTtlDays', d.logTtlDays),
    historyRetentionDays: num(
      raw,
      'historyRetentionDays',
      d.historyRetentionDays,
    ),
    privateHostAllowance: list(raw.privateHostAllowance),
  };
  return validateWebhookSettings(settings, env);
}
