/** Options of a `@JobHandler`, as the author wrote them. */
export interface JobHandlerOptions {
  /** Lease length, 5 s to 4 h; the worker heartbeats at half of it. */
  leaseMs?: number;
  /** Per-type concurrency cap on one worker instance (bulkhead), at least 1. */
  concurrency?: number;
  /** Per-type cap across the whole fleet, at least 1; unset = unlimited. */
  fleetConcurrency?: number;
  /** Longest one run may take before its signal aborts with reason `timeout`; at least `leaseMs`, default 15 min. */
  maxRuntimeMs?: number;
}

export interface ResolvedHandlerOptions {
  type: string;
  leaseMs: number;
  concurrency: number;
  fleetConcurrency: number | undefined;
  maxRuntimeMs: number;
}

export const DEFAULT_HANDLER_OPTIONS = {
  leaseMs: 60_000,
  concurrency: 10,
  maxRuntimeMs: 15 * 60_000,
} as const;

const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 4 * 3_600_000;
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*\.[a-z0-9]+(-[a-z0-9]+)*$/;

/** `<domain>.<action>`, lower-case kebab-case on both sides of a single dot. */
export function validateJobTypeName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1;

/** Applies defaults explicitly and throws one error naming the type and the broken option (boot fails on it). */
export function resolveHandlerOptions(
  type: string,
  options: JobHandlerOptions,
): ResolvedHandlerOptions {
  const fail = (detail: string): never => {
    throw new Error(`invalid @JobHandler("${type}"): ${detail}`);
  };
  if (!validateJobTypeName(type))
    fail('type must look like <domain>.<action> in kebab-case');

  const leaseMs = options.leaseMs ?? DEFAULT_HANDLER_OPTIONS.leaseMs;
  if (
    !Number.isInteger(leaseMs) ||
    leaseMs < MIN_LEASE_MS ||
    leaseMs > MAX_LEASE_MS
  )
    fail(`leaseMs must be an integer from ${MIN_LEASE_MS} to ${MAX_LEASE_MS}`);

  const concurrency =
    options.concurrency ?? DEFAULT_HANDLER_OPTIONS.concurrency;
  if (!isPositiveInt(concurrency)) fail('concurrency must be an integer ≥ 1');

  const fleet = options.fleetConcurrency;
  if (fleet !== undefined && !isPositiveInt(fleet))
    fail('fleetConcurrency must be an integer ≥ 1');

  const maxRuntimeMs =
    options.maxRuntimeMs ??
    Math.max(DEFAULT_HANDLER_OPTIONS.maxRuntimeMs, leaseMs);
  if (!Number.isInteger(maxRuntimeMs) || maxRuntimeMs < leaseMs)
    fail('maxRuntimeMs must be an integer ≥ leaseMs');

  return {
    type,
    leaseMs,
    concurrency,
    fleetConcurrency: fleet,
    maxRuntimeMs,
  };
}
