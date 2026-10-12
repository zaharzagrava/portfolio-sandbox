const HOUR = 3_600_000;

export interface RotationConfig {
  /** An ACTIVE key signs at least this long before it may be replaced. */
  activeMinAgeMs: number;
  /** A NEXT key is published at least this long before it signs (verifiers' JWKS caches must know it). */
  nextPublishedMinMs: number;
  /** A RETIRED key stays published this long after retirement. */
  retiredKeepMs: number;
}

export const DEFAULT_ROTATION_CONFIG: RotationConfig = {
  activeMinAgeMs: 7 * 24 * HOUR,
  nextPublishedMinMs: 24 * HOUR,
  retiredKeepMs: 24 * HOUR,
};

export interface RotationKey {
  kid: string;
  status: 'NEXT' | 'ACTIVE' | 'RETIRED';
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
}

export type RotationAction =
  | { type: 'create'; status: 'ACTIVE' | 'NEXT' }
  | { type: 'promote'; retire: string; activate: string }
  | { type: 'purge'; kid: string };

/**
 * What the rotation job should do now (FR-062). Pure: the clock is a parameter. An empty list means nothing to do.
 * The job applies the list, reloads the keys and asks again until the answer is empty, so a fresh environment ends
 * with one ACTIVE and one NEXT.
 */
export function decideRotation(
  keys: RotationKey[],
  now: Date,
  config: RotationConfig,
): RotationAction[] {
  const age = (since: Date | null) =>
    since ? now.getTime() - since.getTime() : 0;
  const actions: RotationAction[] = [];
  const current = keys.find((k) => k.status === 'ACTIVE');
  // Several NEXT keys cannot exist (unique index); if they did, the newest one is the candidate.
  const candidate = keys
    .filter((k) => k.status === 'NEXT')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (!current) actions.push({ type: 'create', status: 'ACTIVE' });
  else if (!candidate) actions.push({ type: 'create', status: 'NEXT' });
  else if (
    age(current.activatedAt ?? current.createdAt) >= config.activeMinAgeMs &&
    age(candidate.createdAt) >= config.nextPublishedMinMs
  )
    actions.push({
      type: 'promote',
      retire: current.kid,
      activate: candidate.kid,
    });

  for (const key of keys)
    if (
      key.status === 'RETIRED' &&
      key.retiredAt &&
      age(key.retiredAt) > config.retiredKeepMs
    )
      actions.push({ type: 'purge', kid: key.kid });
  return actions;
}
