import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidCursorError } from './payment-errors';

export interface PaymentCursor {
  createdAt: Date;
  id: string;
}

const sign = (payload: string, secret: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

/** `base64url(createdAt|id).signature`: opaque to clients, tamper-evident. */
export function encodePaymentCursor(
  cursor: PaymentCursor,
  secret: string,
): string {
  const payload = Buffer.from(
    `${cursor.createdAt.toISOString()}|${cursor.id}`,
  ).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function decodePaymentCursor(
  raw: string,
  secret: string,
): PaymentCursor {
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined)
    throw new InvalidCursorError();
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    throw new InvalidCursorError();
  const [iso, id] = Buffer.from(payload, 'base64url').toString().split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) throw new InvalidCursorError();
  return { createdAt, id };
}
