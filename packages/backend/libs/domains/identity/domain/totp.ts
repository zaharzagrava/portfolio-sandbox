import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 over HMAC-SHA-1, 6 digits, 30 s: what every authenticator app implements (R-06). */
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 random bits, base32 encoded (32 characters). */
export function generateSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** The code of one time step (RFC 4226 dynamic truncation). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret))
    .update(counter)
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const stepAt = (nowMs: number): number =>
  Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

const equal = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Accepts the code of the current step or of one step either side, and only for a step above `lastStep`: the same
 * code cannot be used twice. The caller persists the returned step with a conditional write (the store, not this
 * function, is the replay guard).
 */
export function verifyTotp(input: {
  secret: string;
  code: string;
  nowMs: number;
  lastStep?: number | null;
}): { valid: true; step: number } | { valid: false; step: null } {
  if (!/^[0-9]{6}$/.test(input.code)) return { valid: false, step: null };
  const now = stepAt(input.nowMs);
  let accepted: number | null = null;
  // Every candidate is compared (no early exit) so timing does not reveal which step matched.
  for (const step of [now - 1, now, now + 1]) {
    const match = equal(totpCode(input.secret, step), input.code);
    const fresh = input.lastStep == null || step > input.lastStep;
    if (match && fresh && accepted === null) accepted = step;
  }
  return accepted === null
    ? { valid: false, step: null }
    : { valid: true, step: accepted };
}

export function otpauthUri(input: {
  issuer: string;
  label: string;
  secret: string;
}): string {
  const label = encodeURIComponent(`${input.issuer}:${input.label}`);
  const query = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
