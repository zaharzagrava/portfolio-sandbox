import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Guest carts are keyed by a random id in a cookie, HMAC-signed with a dedicated secret so a client cannot enumerate or
 * hijack other guests' carts by guessing ids (S10 FR-004, AS-11). Pure: the secret is a parameter.
 */
const GUEST_PREFIX = 'guest:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sign = (secret: string, value: string): string =>
  createHmac('sha256', secret).update(value).digest('base64url');

export function issueGuestToken(secret: string): {
  cartId: string;
  token: string;
} {
  const cartId = `${GUEST_PREFIX}${randomUUID()}`;
  return { cartId, token: `${cartId}.${sign(secret, cartId)}` };
}

/** The cart id a token names, or `null` for anything that is not a token we issued. Never throws. */
export function verifyGuestToken(
  secret: string,
  token: string | undefined | null,
): string | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const cartId = token.slice(0, dot);
  if (!cartId.startsWith(GUEST_PREFIX)) return null;
  if (!UUID.test(cartId.slice(GUEST_PREFIX.length))) return null;
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, cartId));
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? cartId : null;
}

export const userCartId = (userId: string): string => `user:${userId}`;
