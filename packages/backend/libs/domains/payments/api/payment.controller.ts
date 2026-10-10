import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { PaymentQueryService } from '../application/payment-query.service';
import { PaymentIntentService } from '../application/payment-intent.service';
import { CreatePaymentIntentDto } from './payment.dto';

/** Payment routes (S13 contracts/http.md): thin, one service call per route. */
@ApiTags('payments')
@Controller()
export class PaymentController {
  constructor(
    private readonly intents: PaymentIntentService,
    private readonly queries: PaymentQueryService,
  ) {}

  @Firewall({ sensitive: true })
  @RateLimit('payments.create.user')
  @Idempotent()
  @HttpCode(202)
  @Post('payments/intents')
  async create(
    @User() user: AuthenticatedUser,
    @Body() body: CreatePaymentIntentDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const accepted = await this.intents.accept(user.id, {
      orderId: body.orderId,
      paymentMethodId: body.paymentMethodId,
    });
    res.setHeader('Location', `/api/payments/${accepted.paymentId}`);
    return accepted;
  }

  @Firewall({ sensitive: true })
  @RateLimit('payments.read.user')
  @Get('payments/:paymentId')
  getOne(
    @User() user: AuthenticatedUser,
    @Param('paymentId') paymentId: string,
  ) {
    return this.queries.getOwned(user.id, paymentId);
  }
}
