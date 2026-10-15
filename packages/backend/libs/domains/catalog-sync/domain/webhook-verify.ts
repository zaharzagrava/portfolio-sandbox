import { createHmac, timingSafeEqual } from 'node:crypto';

/** Webhook authenticity rules (AS-27, AS-29, FR-030). Pure: the clock is passed in. */
export const WEBHOOK_TOLERANCE_MS = 300_000;

/**
 * Base64 HMAC-SHA256 over the raw request bytes, compared in constant time.
 * A missing, mis-sized or non-matching signature is `false`; never throws.
 */
export function verifyHmacSha256Base64(
  secret: string | Buffer,
  rawBody: Buffer,
  signature: string | undefined,
): boolean {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  if (secret.length === 0) return false;
  const expected = Buffer.from(
    createHmac('sha256', secret).update(rawBody).digest('base64'),
    'utf8',
  );
  const given = Buffer.from(signature, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/**
 * `ok` within 300 s of `now` (inclusive), `stale` beyond it (older, or implausibly far in the future),
 * `invalid` when unparseable. No timestamp (WooCommerce) is `ok`: the delivery-ID dedupe protects instead.
 */
export function checkTimestamp(
  triggeredAt: string | Date | undefined,
  now: Date,
): 'ok' | 'stale' | 'invalid' {
  if (triggeredAt === undefined) return 'ok';
  const at =
    triggeredAt instanceof Date
      ? triggeredAt.getTime()
      : triggeredAt.trim() === ''
        ? Number.NaN
        : new Date(triggeredAt).getTime();
  if (Number.isNaN(at)) return 'invalid';
  return Math.abs(now.getTime() - at) > WEBHOOK_TOLERANCE_MS ? 'stale' : 'ok';
}
