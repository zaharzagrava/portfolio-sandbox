export interface ShutdownConfig {
  /** Time between "not ready" and refusing new connections, so the load balancer deregisters the instance. */
  drainDelayMs: number;
  /** Time in-flight requests get to finish after the server stops accepting. */
  requestDrainMs: number;
  /** Absolute limit: past it the process exits 1 with `forced shutdown`. */
  hardTimeoutMs: number;
  /** Must exceed the load balancer idle timeout (60 s) or the balancer reuses sockets the server just closed. */
  keepAliveMs: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_SHUTDOWN_CONFIG: ShutdownConfig = {
  drainDelayMs: 5_000,
  requestDrainMs: 15_000,
  hardTimeoutMs: 25_000,
  keepAliveMs: 65_000,
  headersTimeoutMs: 66_000,
  requestTimeoutMs: 30_000,
};

const LOAD_BALANCER_IDLE_TIMEOUT_MS = 60_000;

type Source = Partial<
  Record<
    | 'shutdown_drain_delay_ms'
    | 'shutdown_request_drain_ms'
    | 'shutdown_hard_timeout_ms'
    | 'server_keep_alive_ms'
    | 'server_headers_timeout_ms'
    | 'server_request_timeout_ms',
    number
  >
>;

function positiveInt(
  source: Source,
  key: keyof Source,
  fallback: number,
): number {
  const value = source[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${key} must be a positive integer (got ${value})`);
  return value;
}

/** Applies the defaults and the cross-field rules (S54 G-41, FR-040): a bad combination fails startup, never at deploy time. */
export function resolveShutdownConfig(source: Source): ShutdownConfig {
  const d = DEFAULT_SHUTDOWN_CONFIG;
  const cfg: ShutdownConfig = {
    drainDelayMs: positiveInt(
      source,
      'shutdown_drain_delay_ms',
      d.drainDelayMs,
    ),
    requestDrainMs: positiveInt(
      source,
      'shutdown_request_drain_ms',
      d.requestDrainMs,
    ),
    hardTimeoutMs: positiveInt(
      source,
      'shutdown_hard_timeout_ms',
      d.hardTimeoutMs,
    ),
    keepAliveMs: positiveInt(source, 'server_keep_alive_ms', d.keepAliveMs),
    headersTimeoutMs: positiveInt(
      source,
      'server_headers_timeout_ms',
      d.headersTimeoutMs,
    ),
    requestTimeoutMs: positiveInt(
      source,
      'server_request_timeout_ms',
      d.requestTimeoutMs,
    ),
  };
  return validateShutdownConfig(cfg);
}

/** Applies the defaults to an already camel-cased partial (options, tests) and validates the result. */
export function mergeShutdownConfig(
  partial: Partial<ShutdownConfig> = {},
): ShutdownConfig {
  return validateShutdownConfig({ ...DEFAULT_SHUTDOWN_CONFIG, ...partial });
}

export function validateShutdownConfig(cfg: ShutdownConfig): ShutdownConfig {
  if (cfg.drainDelayMs + cfg.requestDrainMs >= cfg.hardTimeoutMs) {
    throw new Error(
      `drain delay (${cfg.drainDelayMs}) + request drain (${cfg.requestDrainMs}) must be below the hard timeout (${cfg.hardTimeoutMs})`,
    );
  }
  if (cfg.keepAliveMs <= LOAD_BALANCER_IDLE_TIMEOUT_MS) {
    throw new Error(
      `server keep-alive (${cfg.keepAliveMs}) must exceed the load balancer idle timeout (${LOAD_BALANCER_IDLE_TIMEOUT_MS})`,
    );
  }
  if (cfg.headersTimeoutMs <= cfg.keepAliveMs) {
    throw new Error(
      `server headers timeout (${cfg.headersTimeoutMs}) must exceed keep-alive (${cfg.keepAliveMs})`,
    );
  }
  return cfg;
}
