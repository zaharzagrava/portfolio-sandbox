/**
 * The pointer rule (FR-025, AS-39): versions are sortable UTC timestamps, so "newer" is a plain string comparison. The
 * pointer moves from `V_n` to `V_m` only when `V_m > V_n`; an equal or older version never moves it. An operator may set it
 * backwards through a separate, explicit path (`forceSet`).
 */
export function canAdvance(current: string | null, next: string): boolean {
  return current === null || next > current;
}

/** `2026-10-10T10-00-00-000Z-<suffix>`: the clock instant first (ordering), a short suffix after it (two builds in one millisecond). */
export function newSnapshotVersion(at: Date, suffix: string): string {
  return `${at.toISOString().replace(/[:.]/g, '-')}-${suffix}`;
}
