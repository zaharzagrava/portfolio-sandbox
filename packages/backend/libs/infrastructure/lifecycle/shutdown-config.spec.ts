import {
  DEFAULT_SHUTDOWN_CONFIG,
  resolveShutdownConfig,
} from './shutdown-config';

describe('shutdown config (U-SDC)', () => {
  it('defaults satisfy the rule and keep the 25 s hard timeout', () => {
    expect(resolveShutdownConfig({})).toEqual(DEFAULT_SHUTDOWN_CONFIG);
    expect(DEFAULT_SHUTDOWN_CONFIG.hardTimeoutMs).toBe(25_000);
  });

  it.each([
    [
      'S54 AS-67: drain delay + request drain equal to the hard timeout',
      { drainDelayMs: 10_000, requestDrainMs: 15_000, hardTimeoutMs: 25_000 },
    ],
    [
      'S54 AS-67: drain delay + request drain above the hard timeout',
      { drainDelayMs: 20_000, requestDrainMs: 20_000, hardTimeoutMs: 25_000 },
    ],
  ])('%s is rejected', (_name, cfg) => {
    expect(() =>
      resolveShutdownConfig({
        shutdown_drain_delay_ms: cfg.drainDelayMs,
        shutdown_request_drain_ms: cfg.requestDrainMs,
        shutdown_hard_timeout_ms: cfg.hardTimeoutMs,
      }),
    ).toThrow(/hard timeout/i);
  });

  it('S54 AS-67: 5 s + 15 s < 25 s is accepted', () => {
    expect(
      resolveShutdownConfig({
        shutdown_drain_delay_ms: 5_000,
        shutdown_request_drain_ms: 15_000,
        shutdown_hard_timeout_ms: 25_000,
      }),
    ).toMatchObject({
      drainDelayMs: 5_000,
      requestDrainMs: 15_000,
      hardTimeoutMs: 25_000,
    });
  });

  it.each([-1, 0, 1.5, Number.NaN])(
    'rejects a non-positive-integer timing (%s)',
    (bad) => {
      expect(() =>
        resolveShutdownConfig({ shutdown_drain_delay_ms: bad }),
      ).toThrow(/shutdown_drain_delay_ms/);
    },
  );

  it('server keep-alive must exceed 60 s and headers timeout must exceed keep-alive (AS-68)', () => {
    expect(() =>
      resolveShutdownConfig({ server_keep_alive_ms: 60_000 }),
    ).toThrow(/keep.?alive/i);
    expect(() =>
      resolveShutdownConfig({
        server_keep_alive_ms: 65_000,
        server_headers_timeout_ms: 65_000,
      }),
    ).toThrow(/headers/i);
  });
});
