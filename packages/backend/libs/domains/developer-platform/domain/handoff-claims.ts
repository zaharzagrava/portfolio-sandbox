export const HANDOFF_AUDIENCE = 'marketplace-widget';
/** Longest lifetime of a hand-off token (`WIDGET_LIMITS.handoffMaxLifetimeSec` in the contract package). */
const MAX_LIFETIME_SEC = 300;
const NBF_SKEW_SEC = 30;
const IAT_SKEW_SEC = 60;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type HandoffRejection =
  | 'bad_subject'
  | 'bad_jti'
  | 'expired'
  | 'too_long_lived'
  | 'bad_audience'
  | 'bad_issuer'
  | 'not_yet_valid'
  | 'bad_issued_at'
  | 'bad_email'
  | 'missing_exp';

export interface AcceptedHandoff {
  sub: string;
  jti: string;
  exp: number;
  email: string | null;
}

export type HandoffResult =
  | { ok: true; claims: AcceptedHandoff }
  | { ok: false; reason: HandoffRejection };

const reject = (reason: HandoffRejection): HandoffResult => ({
  ok: false,
  reason,
});

const isInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v);

/**
 * The claims policy of a hand-off token (FR-018, AS-24), applied after the signature was verified. The clock is passed in
 * so a frozen clock proves every boundary; the library's own `maxAge` (needs `iat`, reads the wall clock) is not used.
 * Every rejection is one closed reason; callers show the shop one body for all of them.
 */
export function evaluateHandoffClaims(
  claims: Record<string, unknown>,
  context: { now: Date; publishableKey: string },
): HandoffResult {
  const now = Math.floor(context.now.getTime() / 1000);
  if (claims.aud !== HANDOFF_AUDIENCE) return reject('bad_audience');
  if (claims.iss !== context.publishableKey) return reject('bad_issuer');
  const { sub, jti, exp, nbf, iat, email } = claims;
  if (typeof sub !== 'string' || sub.length < 1 || sub.length > 128)
    return reject('bad_subject');
  if (typeof jti !== 'string' || jti.length < 8 || jti.length > 128)
    return reject('bad_jti');
  if (!isInt(exp)) return reject('missing_exp');
  if (exp <= now) return reject('expired');
  if (exp - now > MAX_LIFETIME_SEC) return reject('too_long_lived');
  if (nbf !== undefined && (!isInt(nbf) || nbf - now > NBF_SKEW_SEC))
    return reject('not_yet_valid');
  if (iat !== undefined && (!isInt(iat) || iat - now > IAT_SKEW_SEC))
    return reject('bad_issued_at');
  if (
    email !== undefined &&
    (typeof email !== 'string' || email.length > 254 || !EMAIL.test(email))
  )
    return reject('bad_email');
  return {
    ok: true,
    claims: { sub, jti, exp, email: typeof email === 'string' ? email : null },
  };
}
