import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { parse } from 'cookie';
import { ApiConfigService } from '@app/common/config';
import { Environment } from '@app/common/types';
import { issueGuestToken, verifyGuestToken } from '../domain/guest-cart-token';

export const CART_COOKIE = 'cart';

/**
 * The guest cart cookie (S10 FR-004, FR-005): `cart=guest:<uuid>.<signature>`, HttpOnly, SameSite=Lax, `Secure`
 * outside local, 30 days. The signing secret is the dedicated `cart_cookie_secret` (never `jwt_secret`); outside
 * production an unset secret is replaced by a per-process random one (carts of a restarted dev server are orphaned).
 */
@Injectable()
export class CartCookie {
  private readonly secret: string;

  constructor(private readonly config: ApiConfigService) {
    const configured = config.get('cart_cookie_secret');
    if (configured) this.secret = configured;
    else {
      new Logger(CartCookie.name).warn(
        'cart_cookie_secret is not set: using a random per-process secret',
      );
      this.secret = randomBytes(32).toString('hex');
    }
  }

  private options(maxAgeMs: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.config.get('node_env') !== Environment.local,
      path: '/',
      maxAge: maxAgeMs,
      // the value is `guest:<uuid>.<base64url>`: only cookie-safe characters, sent as is
      encode: (value: string) => value,
    };
  }

  /** Whether the request carried a cart cookie at all (merge clears it either way). */
  present(req: Request): boolean {
    return CART_COOKIE in parse(req.headers.cookie ?? '');
  }

  /** The guest cart id the request's cookie names, or `null` for no cookie or one that fails verification. */
  verified(req: Request): string | null {
    const value = parse(req.headers.cookie ?? '')[CART_COOKIE];
    return verifyGuestToken(this.secret, value);
  }

  /** A new guest identity; the cookie is set on `res`. */
  issue(res: Response): string {
    const { cartId, token } = issueGuestToken(this.secret);
    res.cookie(
      CART_COOKIE,
      token,
      this.options(this.config.get('orders_cart_line_ttl_days') * 86_400_000),
    );
    return cartId;
  }

  clear(res: Response): void {
    res.cookie(CART_COOKIE, '', this.options(0));
  }
}
