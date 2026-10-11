import { z } from 'zod';
import { cartSchema } from '@marketplace-sandbox/contracts';
import { Endpoint } from './endpoint';

/**
 * S10 `GET /api/cart`: the member's cart (bearer) or the guest's (the `cart` token, forwarded alone: the session
 * cookie and every other cookie stay in the BFF). Required by the cart page, so it does not feed the breaker.
 */
export const cartRead = (
  guestCartToken?: string,
): Endpoint<z.infer<typeof cartSchema>> => ({
  name: 'cart',
  upstream: 'orders',
  method: 'GET',
  path: '/api/cart',
  schema: cartSchema,
  identity: 'optional',
  sharedCache: false,
  breaker: false,
  guestCartToken,
});
