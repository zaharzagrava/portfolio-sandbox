import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import * as cookie from 'cookie';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { Environment } from '@app/common/types';
import { CartRepository } from '../infra/cart.repository';
import { CartIdentity } from './cart-identity';
import { SetCartLineDto } from './orders.dto';

const CART_COOKIE = 'cart';

/**
 * Cart API (SD-19): pure DynamoDB - add-to-cart storms during a drop never
 * touch Postgres. Logged-in users use `user:<id>`, guests a signed cookie id.
 */
@ApiTags('cart')
@Controller('cart')
export class CartController {
  private readonly identity: CartIdentity;

  constructor(
    private readonly carts: CartRepository,
    private readonly config: ApiConfigService,
  ) {
    this.identity = new CartIdentity(config.get('cart_cookie_secret') || config.get('jwt_secret'));
  }

  @Firewall({ anonymous: true })
  @Get()
  async get(@Req() req: Request & { user?: UserRawDto }, @Res({ passthrough: true }) res: Response) {
    return { lines: await this.carts.list(this.cartId(req, res)) };
  }

  @Firewall({ anonymous: true })
  @Put('items/:productId')
  async setLine(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() body: SetCartLineDto,
    @Req() req: Request & { user?: UserRawDto },
    @Res({ passthrough: true }) res: Response,
  ) {
    const cartId = this.cartId(req, res);
    await this.carts.setLine(cartId, productId, body.quantity);
    return { lines: await this.carts.list(cartId) };
  }

  /** Called right after login: guest cart lines move into the user's cart. */
  @Firewall()
  @Post('merge')
  async merge(@User() user: UserRawDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const guest = this.identity.verify(cookie.parse(req.headers.cookie ?? '')[CART_COOKIE]);
    const target = CartIdentity.userCartId(user.id);
    res.clearCookie(CART_COOKIE, { path: '/' });
    return { lines: guest ? await this.carts.merge(guest, target) : await this.carts.list(target) };
  }

  private cartId(req: Request & { user?: UserRawDto }, res: Response): string {
    if (req.user) return CartIdentity.userCartId(req.user.id);
    const existing = this.identity.verify(cookie.parse(req.headers.cookie ?? '')[CART_COOKIE]);
    if (existing) return existing;
    const { cartId, token } = this.identity.issueGuestToken();
    res.cookie(CART_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get('node_env') !== Environment.local,
      path: '/',
      maxAge: 30 * 86_400_000,
    });
    return cartId;
  }
}
