import { createHmac, timingSafeEqual } from 'node:crypto';
import { Category, CATEGORIES } from './catalog';

/**
 * `<base64url(userId.category)>.<hmac>`: lets a logged-out user unsubscribe
 * from one category from any email, and lets nobody else unsubscribe them.
 * No expiry on purpose - old emails must keep a working unsubscribe link.
 */
export function signUnsubscribe(
  userId: string,
  category: Category,
  secret: string,
): string {
  const payload = Buffer.from(`${userId}.${category}`).toString('base64url');
  return `${payload}.${mac(payload, secret)}`;
}

export function verifyUnsubscribe(
  token: string,
  secret: string,
): { userId: string; category: Category } | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(mac(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return null;
  const [userId, category] = Buffer.from(payload, 'base64url')
    .toString()
    .split('.');
  return CATEGORIES.includes(category as Category)
    ? { userId, category: category as Category }
    : null;
}

const mac = (payload: string, secret: string) =>
  createHmac('sha256', secret)
    .update(`unsubscribe:${payload}`)
    .digest('base64url')
    .slice(0, 22);
