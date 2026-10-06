import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Guest carts are keyed by a random id in a cookie, HMAC-signed so a client
 * can't enumerate or hijack other guests' carts by guessing ids.
 */
export class CartIdentity {
  constructor(private readonly secret: string) {}

  issueGuestToken(): { cartId: string; token: string } {
    const cartId = `guest:${randomUUID()}`;
    return { cartId, token: `${cartId}.${this.sign(cartId)}` };
  }

  /** Returns the cart id if the token's signature is valid. */
  verify(token: string | undefined): string | null {
    if (!token) return null;
    const dot = token.lastIndexOf('.');
    const cartId = token.slice(0, dot);
    const sig = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.sign(cartId));
    return cartId.startsWith('guest:') && sig.length === expected.length && timingSafeEqual(sig, expected) ? cartId : null;
  }

  static userCartId(userId: string): string {
    return `user:${userId}`;
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }
}
