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
import { User, type AuthenticatedUser } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { BillingRateLimit } from '../rate-limit-policies';
import type { Subject } from '../domain/types';
import { BillingApi } from './billing-api.service';
import { ZodPipe } from './zod.pipe';

const shop = (shopId: string): Subject => ({
  subjectType: 'SHOP',
  subjectId: shopId.toLowerCase(),
});
const invoiceId = new ZodPipe(z.string().uuid());

/**
 * A shop's subscription (S17 contracts/http.md): `shop.read` to look, `billing.manage` to act. Thin: access is
 * `ShopScoped`'s (404 for a non-member, 403 for the wrong role, 403/409 for a closed shop), one service call per route.
 */
@ApiTags('billing')
@Controller('shops/:shopId')
export class ShopSubscriptionController {
  constructor(private readonly api: BillingApi) {}

  @ShopScoped('shop.read')
  @RateLimit('default.read')
  @Get('subscription')
  read(@Param('shopId') shopId: string) {
    return this.api.read(shop(shopId));
  }

  @ShopScoped('billing.manage')
  @BillingRateLimit('billing.subscribe.subject')
  @Idempotent()
  @Post('subscription')
  subscribe(
    @Param('shopId') shopId: string,
    @User() user: AuthenticatedUser,
    @Body(new ZodPipe(subscribeRequestSchema))
    body: ReturnType<typeof subscribeRequestSchema.parse>,
  ) {
    return this.api.subscribe(shop(shopId), user.id, body);
  }

  @ShopScoped('billing.manage')
  @BillingRateLimit('billing.preview.subject')
  @HttpCode(200)
  @Post('subscription/preview')
  preview(
    @Param('shopId') shopId: string,
    @Body(new ZodPipe(changeRequestSchema))
    body: ReturnType<typeof changeRequestSchema.parse>,
  ) {
    return this.api.preview(shop(shopId), body);
  }

  @ShopScoped('billing.manage')
  @BillingRateLimit('billing.change.subject')
  @Idempotent()
  @HttpCode(200)
  @Post('subscription/change')
  change(
    @Param('shopId') shopId: string,
    @User() user: AuthenticatedUser,
    @Body(new ZodPipe(changeRequestSchema))
    body: ReturnType<typeof changeRequestSchema.parse>,
  ) {
    return this.api.change(shop(shopId), user.id, body);
  }

  @ShopScoped('billing.manage')
  @BillingRateLimit('billing.change.subject')
  @HttpCode(200)
  @Post('subscription/cancel')
  cancel(
    @Param('shopId') shopId: string,
    @User() user: AuthenticatedUser,
    @Body(new ZodPipe(cancelRequestSchema))
    body: ReturnType<typeof cancelRequestSchema.parse>,
  ) {
    return this.api.cancel(shop(shopId), user.id, body);
  }

  @ShopScoped('billing.manage')
  @BillingRateLimit('billing.change.subject')
  @HttpCode(200)
  @Post('subscription/resume')
  resume(@Param('shopId') shopId: string, @User() user: AuthenticatedUser) {
    return this.api.resume(shop(shopId), user.id);
  }

  @ShopScoped('billing.manage')
  @BillingRateLimit('billing.payment-method.subject')
  @Put('subscription/payment-method')
  updatePaymentMethod(
    @Param('shopId') shopId: string,
    @Body(new ZodPipe(paymentMethodRequestSchema))
    body: ReturnType<typeof paymentMethodRequestSchema.parse>,
  ) {
    return this.api.updatePaymentMethod(shop(shopId), body.paymentMethodRef);
  }

  @ShopScoped('billing.manage')
  @RateLimit('default.read')
  @Get('invoices')
  invoices(
    @Param('shopId') shopId: string,
    @Query(new ZodPipe(invoiceListQuerySchema))
    query: ReturnType<typeof invoiceListQuerySchema.parse>,
  ) {
    return this.api.invoices(shop(shopId), query);
  }

  @ShopScoped('billing.manage')
  @RateLimit('default.read')
  @Get('invoices/:invoiceId')
  invoice(
    @Param('shopId') shopId: string,
    @Param('invoiceId', invoiceId) id: string,
  ) {
    return this.api.invoice(shop(shopId), id);
  }
}
