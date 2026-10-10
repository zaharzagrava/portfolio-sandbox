export const MAX_ID_TOKEN_BYTES = 8 * 1024;
const MAX_SUBJECT = 255;
const MAX_EMAIL = 254;

export interface OidcIdentityClaims {
  subject: string;
  /** Lower-cased, trimmed, shape-checked; `null` when the provider sent none or an unusable one. */
  email: string | null;
  /** True only for the boolean `true` claim with a usable e-mail; "true" the string is not verification. */
  emailVerified: boolean;
}

export type ClaimsResult =
  | { ok: true; identity: OidcIdentityClaims }
  | { ok: false; reason: 'claims' | 'subject' };

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** Reads the verified claims object of an ID token; the signature and `iss`/`aud`/`exp`/`nonce` are checked elsewhere. */
export function readIdTokenClaims(claims: unknown): ClaimsResult {
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims))
    return { ok: false, reason: 'claims' };
  const c = claims as Record<string, unknown>;

  const sub = c.sub;
  if (
    typeof sub !== 'string' ||
    sub.trim().length === 0 ||
    sub.length > MAX_SUBJECT
  )
    return { ok: false, reason: 'subject' };

  const raw = typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
  const email =
    raw.length > 0 && raw.length <= MAX_EMAIL && EMAIL.test(raw) ? raw : null;
  return {
    ok: true,
    identity: {
      subject: sub,
      email,
      emailVerified: email !== null && c.email_verified === true,
    },
  };
}
