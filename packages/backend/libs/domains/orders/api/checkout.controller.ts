import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { CheckoutService } from '../application/checkout.service';
import { CheckoutRequestDto } from './checkout.dto';

/** `POST /checkout` (S10 US2): idempotent per buyer and key, rate limited fail closed, answers `202` with `Location`. */
@ApiTags('checkout')
@Controller()
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Firewall({ sensitive: true })
  @RateLimit('checkout.create')
  @Idempotent()
  @HttpCode(202)
  @Post('checkout')
  async checkout(
    @User() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: CheckoutRequestDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.checkoutService.checkout(
      user.id,
      idempotencyKey,
      {
        expectedTotalMinor: body.expectedTotalMinor,
      },
    );
    res.setHeader('Location', `/api/orders/${result.orderId}`);
    return result;
  }
}
