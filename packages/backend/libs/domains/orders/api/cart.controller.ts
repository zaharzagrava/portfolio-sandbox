import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { CartService } from '../application/cart.service';
import { userCartId } from '../domain/guest-cart-token';
import { CartCookie } from './cart-cookie';
import { SetCartLineDto } from './cart.dto';

/**
 * Cart API (S10 US1): DynamoDB only, so add-to-cart storms never touch Postgres. A signed-in caller always uses
 * `user:<id>`; a guest uses the signed cookie. No route takes a cart id.
 */
@ApiTags('cart')
@Controller('cart')
export class CartController {
  constructor(
    private readonly cart: CartService,
    private readonly cookie: CartCookie,
  ) {}

  /** Never issues a cookie: a guest without a (valid) cookie has an empty cart. */
  @Firewall({ anonymous: true })
  @Get()
  async get(@User() user: AuthenticatedUser | null, @Req() req: Request) {
    const cartId = user ? userCartId(user.id) : this.cookie.verified(req);
    return cartId ? this.cart.get(cartId) : { lines: [], droppedLines: 0 };
  }

  @Firewall({ anonymous: true })
  @RateLimit('orders.cart-write.identity')
  @Put('items/:productId')
  async setLine(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() body: SetCartLineDto,
    @User() user: AuthenticatedUser | null,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cartId = user
      ? userCartId(user.id)
      : (this.cookie.verified(req) ?? this.cookie.issue(res));
    return this.cart.setLine(cartId, productId, body.quantity);
  }

  /** Right after login: the guest cart's lines move into the user's cart; the cookie is always cleared. */
  @Firewall()
  @RateLimit('orders.cart-write.identity')
  @HttpCode(200)
  @Post('merge')
  async merge(
    @User() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const sent = this.cookie.present(req);
    const result = await this.cart.merge(
      this.cookie.verified(req),
      userCartId(user.id),
    );
    if (sent) this.cookie.clear(res);
    return result;
  }
}
