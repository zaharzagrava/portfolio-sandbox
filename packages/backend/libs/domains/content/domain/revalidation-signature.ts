import { createHmac, timingSafeEqual } from 'node:crypto';

/** A receiver refuses a timestamp older than this (S27 AS-51). */
export const MAX_SIGNATURE_AGE_SECONDS = 300;

/** Hex HMAC-SHA256 of `"<timestamp>.<raw body>"` (S27 FR-031, V.8): the timestamp is part of what is signed. */
export const signRevalidation = (
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string =>
  createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');

/**
 * What the receiver does (documented here so both halves test the same rule): recompute, compare in constant time,
 * refuse a timestamp more than 5 minutes from `nowSeconds`. Never throws.
 */
export function verifyRevalidation(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  nowSeconds: number,
): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SIGNATURE_AGE_SECONDS)
    return false;
  const expected = Buffer.from(
    signRevalidation(secret, Number(timestamp), rawBody),
    'hex',
  );
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
