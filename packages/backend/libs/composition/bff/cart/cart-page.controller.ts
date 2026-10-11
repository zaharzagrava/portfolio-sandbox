import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { CartPageResponse } from '@marketplace-sandbox/contracts';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { CredentialsGuard } from '../credentials/credentials.guard';
import {
  readCookie,
  type RequestWithCredentials,
} from '../credentials/request-credentials';
import '../rate-limit-policies';
import { CartPageService } from './cart-page.service';

/** `GET /bff/cart` (W03 B-3): per-visitor data, never cached, never sets a cookie. */
@ApiTags('bff')
@Controller('bff')
export class CartPageController {
  constructor(private readonly pages: CartPageService) {}

  @UseGuards(CredentialsGuard)
  @RateLimit('bff.cart-page.principal')
  @Get('cart')
  async get(
    @Req() req: RequestWithCredentials,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CartPageResponse> {
    res.setHeader('Cache-Control', 'private, no-store');
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    return this.pages.load({
      credentials: req.credentials!,
      guestCartCookie: readCookie(req, 'cart'),
      signal: controller.signal,
    });
  }
}
