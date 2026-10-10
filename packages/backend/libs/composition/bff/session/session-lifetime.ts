export interface LifetimeConfig {
  idleMs: number;
  absoluteMs: number;
  touchIntervalMs: number;
}

export interface Lifetime {
  idleExp: number;
  absoluteExp: number;
}

/** Deadlines of a new session; the identity session (when its expiry is known) caps the absolute one (S48 FR-045). */
export function initialDeadlines(
  now: number,
  config: Pick<LifetimeConfig, 'idleMs' | 'absoluteMs'>,
  identityExp?: number,
): Lifetime {
  const absoluteExp = Math.min(
    now + config.absoluteMs,
    identityExp ?? Number.POSITIVE_INFINITY,
  );
  return { idleExp: Math.min(now + config.idleMs, absoluteExp), absoluteExp };
}

export function expiryOf(
  life: Lifetime,
  now: number,
): 'active' | 'idle' | 'absolute' {
  if (now >= life.absoluteExp) return 'absolute';
  if (now >= life.idleExp) return 'idle';
  return 'active';
}

/** Store TTL: the time left until whichever deadline comes first. */
export function ttlMs(life: Lifetime, now: number): number {
  return Math.max(0, Math.min(life.idleExp, life.absoluteExp) - now);
}

/** The idle extension is written at most once per interval (a read must not become a write every time). */
export function shouldTouch(
  lastWrittenAt: number,
  now: number,
  intervalMs: number,
): boolean {
  return now - lastWrittenAt >= intervalMs;
}

export function touchedIdleExp(
  life: Lifetime,
  now: number,
  config: Pick<LifetimeConfig, 'idleMs'>,
): number {
  return Math.min(now + config.idleMs, life.absoluteExp);
}
