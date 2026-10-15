import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  cancelRequestSchema,
  changeRequestSchema,
  invoiceListQuerySchema,
  paymentMethodRequestSchema,
  subscribeRequestSchema,
} from '@marketplace-sandbox/contracts';
import { Firewall, User, type AuthenticatedUser } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { BillingRateLimit } from '../rate-limit-policies';
import type { Subject } from '../domain/types';
import { BillingApi } from './billing-api.service';
import { ZodPipe } from './zod.pipe';

const buyer = (user: AuthenticatedUser): Subject => ({
  subjectType: 'USER',
  subjectId: user.id,
});
const invoiceId = new ZodPipe(z.string().uuid());

/**
 * Marketplace Plus for a buyer (S17 contracts/http.md): the same shapes as a shop's routes, with the session's user
 * as the subject. There is no permission to check: a buyer only ever sees their own subscription and invoices.
 */
@ApiTags('billing')
@Controller('me')
export class BuyerSubscriptionController {
  constructor(private readonly api: BillingApi) {}

  @Firewall()
  @RateLimit('default.read')
  @Get('subscription')
  read(@User() user: AuthenticatedUser) {
    return this.api.read(buyer(user));
  }

  @Firewall()
  @BillingRateLimit('billing.subscribe.subject')
  @Idempotent()
  @Post('subscription')
  subscribe(
    @User() user: AuthenticatedUser,
    @Body(new ZodPipe(subscribeRequestSchema))
    body: ReturnType<typeof subscribeRequestSchema.parse>,
  ) {
    return this.api.subscribe(buyer(user), user.id, body);
  }

  @Firewall()
  @BillingRateLimit('billing.preview.subject')
  @HttpCode(200)
  @Post('subscription/preview')
  preview(
    @User() user: AuthenticatedUser,
    @Body(new ZodPipe(changeRequestSchema))
    body: ReturnType<typeof changeRequestSchema.parse>,
  ) {
    return this.api.preview(buyer(user), body);
  }

  @Firewall()
  @BillingRateLimit('billing.change.subject')
  @Idempotent()
  @HttpCode(200)
  @Post('subscription/change')
  change(
    @User() user: AuthenticatedUser,
    @Body(new ZodPipe(changeRequestSchema))
    body: ReturnType<typeof changeRequestSchema.parse>,
  ) {
    return this.api.change(buyer(user), user.id, body);
  }

  @Firewall()
  @BillingRateLimit('billing.change.subject')
  @HttpCode(200)
  @Post('subscription/cancel')
  cancel(
    @User() user: AuthenticatedUser,
    @Body(new ZodPipe(cancelRequestSchema))
    body: ReturnType<typeof cancelRequestSchema.parse>,
  ) {
    return this.api.cancel(buyer(user), user.id, body);
  }

  @Firewall()
  @BillingRateLimit('billing.change.subject')
  @HttpCode(200)
  @Post('subscription/resume')
  resume(@User() user: AuthenticatedUser) {
    return this.api.resume(buyer(user), user.id);
  }

  @Firewall()
  @BillingRateLimit('billing.payment-method.subject')
  @Put('subscription/payment-method')
  updatePaymentMethod(
    @User() user: AuthenticatedUser,
    @Body(new ZodPipe(paymentMethodRequestSchema))
    body: ReturnType<typeof paymentMethodRequestSchema.parse>,
  ) {
    return this.api.updatePaymentMethod(buyer(user), body.paymentMethodRef);
  }

  @Firewall()
  @RateLimit('default.read')
  @Get('invoices')
  invoices(
    @User() user: AuthenticatedUser,
    @Query(new ZodPipe(invoiceListQuerySchema))
    query: ReturnType<typeof invoiceListQuerySchema.parse>,
  ) {
    return this.api.invoices(buyer(user), query);
  }

  @Firewall()
  @RateLimit('default.read')
  @Get('invoices/:invoiceId')
  invoice(
    @User() user: AuthenticatedUser,
    @Param('invoiceId', invoiceId) id: string,
  ) {
    return this.api.invoice(buyer(user), id);
  }
}
