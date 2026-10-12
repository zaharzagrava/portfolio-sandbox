export const SERVICE_TOKEN_TYP = 'svc+jwt';
export const SERVICE_SUBJECT_PREFIX = 'svc:';
export const DEFAULT_SERVICE_TOKEN_TTL_SEC = 60;
export const MAX_SERVICE_TOKEN_TTL_SEC = 300;

export type MintCheck =
  | { ok: true; ttlSec: number }
  | { ok: false; reason: 'caller' | 'audience' | 'ttl' };

/**
 * What may be minted (FR-070): a plain caller name, an audience from the configured allowlist, and a whole number of
 * seconds between 1 and 300 (default 60). Pure.
 */
export function checkMintRequest(
  input: { caller: string; audience: string; ttlSec?: number },
  allowedAudiences: readonly string[],
): MintCheck {
  const caller = input.caller?.trim() ?? '';
  if (
    !caller ||
    caller !== input.caller ||
    caller.startsWith(SERVICE_SUBJECT_PREFIX)
  )
    return { ok: false, reason: 'caller' };
  if (!allowedAudiences.includes(input.audience))
    return { ok: false, reason: 'audience' };
  const ttlSec = input.ttlSec ?? DEFAULT_SERVICE_TOKEN_TTL_SEC;
  if (
    !Number.isInteger(ttlSec) ||
    ttlSec < 1 ||
    ttlSec > MAX_SERVICE_TOKEN_TTL_SEC
  )
    return { ok: false, reason: 'ttl' };
  return { ok: true, ttlSec };
}

/** The per-endpoint caller allowlist of `@AllowedCallers(...)` (exact, case-sensitive match). */
export const callerAllowed = (
  caller: string,
  allowed: readonly string[],
): boolean => allowed.includes(caller);
