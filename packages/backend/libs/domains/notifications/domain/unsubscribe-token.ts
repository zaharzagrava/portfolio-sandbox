import { createHmac, timingSafeEqual } from 'node:crypto';
import { Category, CATEGORIES } from './catalog';

const VERSION = 'v1';

/**
 * `<base64url(userId|category|v1)>.<hmac>`: lets a logged-out user unsubscribe from one category from any email, and
 * lets nobody else unsubscribe them. Bound to (user, category), signed with the dedicated notification secret. No
 * expiry on purpose - old emails must keep a working unsubscribe link (FR-036).
 */
export function signUnsubscribe(
  userId: string,
  category: Category,
  secret: string,
): string {
  const payload = Buffer.from(`${userId}|${category}|${VERSION}`).toString(
    'base64url',
  );
  return `${payload}.${mac(payload, secret)}`;
}

/** Null for a bad shape, a bad MAC and an unknown category alike: the caller answers all of them the same way. */
export function verifyUnsubscribe(
  token: string,
  secret: string,
): { userId: string; category: Category } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;
  const expected = Buffer.from(mac(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return null;
  const [userId, category, version, ...rest] = Buffer.from(payload, 'base64url')
    .toString()
    .split('|');
  if (!userId || version !== VERSION || rest.length > 0) return null;
  return CATEGORIES.includes(category as Category)
    ? { userId, category: category as Category }
    : null;
}

const mac = (payload: string, secret: string) =>
  createHmac('sha256', secret)
    .update(`unsubscribe:${payload}`)
    .digest('base64url')
    .slice(0, 22);
