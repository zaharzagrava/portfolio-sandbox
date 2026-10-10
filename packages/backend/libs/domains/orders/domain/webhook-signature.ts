import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidSignatureError } from './order-errors';

export { InvalidSignatureError };

/** Stripe's tolerance: an event signed more than five minutes away from now is refused (replay window). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies a `Stripe-Signature` header over the RAW body (S10 FR-036, AS-53). `secrets` holds the current and, during
 * rotation, the previous secret. Constant-time comparison, injected `now`; throws `InvalidSignatureError` for every
 * failure so the caller cannot tell which check failed.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | undefined,
  secrets: string[],
  now: Date,
): void {
  if (!header || secrets.length === 0) throw new InvalidSignatureError();
  let timestamp: number | undefined;
  const candidates: Buffer[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value))
      candidates.push(Buffer.from(value, 'hex'));
  }
  if (timestamp === undefined || candidates.length === 0)
    throw new InvalidSignatureError();
  const age = Math.floor(now.getTime() / 1000) - timestamp;
  if (Math.abs(age) > SIGNATURE_TOLERANCE_SECONDS)
    throw new InvalidSignatureError();

  let ok = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest();
    for (const given of candidates)
      if (given.length === expected.length && timingSafeEqual(given, expected))
        ok = true;
  }
  if (!ok) throw new InvalidSignatureError();
}
