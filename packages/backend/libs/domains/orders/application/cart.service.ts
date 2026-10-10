import { Inject, Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import type { CartDto } from '@marketplace-sandbox/contracts';
import { CART_STORE, type CartStore } from '../domain/ports';
import { CartLineLimitError } from '../domain/order-errors';

/**
 * The cart use cases (S10 US1): set a line, read, merge a guest cart into a user's. The cart lives in the cart store
 * only (no relational access). Callers pass the cart id they derived from the session or the verified guest cookie;
 * no route accepts one from the client.
 */
@Injectable()
export class CartService {
  constructor(
    @Inject(CART_STORE) private readonly store: CartStore,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(cartId: string): Promise<CartDto> {
    return {
      lines: await this.store.list(cartId, this.clock.now()),
      droppedLines: 0,
    };
  }

  /** Set semantics: the quantity replaces the old one, `0` removes the line. */
  async setLine(
    cartId: string,
    productId: string,
    quantity: number,
  ): Promise<CartDto> {
    const outcome = await this.store.setLine(
      cartId,
      productId,
      quantity,
      this.clock.now(),
    );
    if (outcome === 'line_limit')
      throw new CartLineLimitError(this.config.get('orders_cart_max_lines'));
    return this.get(cartId);
  }

  /** Adds the guest cart to the user's (idempotent and race-safe in the store); `null` guest = nothing to merge. */
  async merge(
    guestCartId: string | null,
    userCartId: string,
  ): Promise<CartDto> {
    if (!guestCartId) return this.get(userCartId);
    return this.store.merge(guestCartId, userCartId, this.clock.now());
  }
}
