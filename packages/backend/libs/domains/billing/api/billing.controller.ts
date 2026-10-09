import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { BillingService } from '../application/billing.service';
import { EntitlementsService } from '../application/entitlements.service';
import { ChangeSubscriptionDto, SubscribeDto } from './billing.dto';

@ApiTags('billing')
@Controller()
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Firewall({ anonymous: true, skipThrottle: true })
  @Header('Cache-Control', 'public, s-maxage=300')
  @Get('plans')
  plans() {
    return this.billing.plans();
  }

  // --- shop plans --- //
  @ShopScoped('shop.read')
  @Get('shops/:shopId/subscription')
  async shopSubscription(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return {
      subscription: await this.billing.forSubject('SHOP', shopId),
      entitlements: await this.entitlements.get('SHOP', shopId),
    };
  }

  @ShopScoped('billing.manage')
  @Post('shops/:shopId/subscription')
  subscribeShop(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: SubscribeDto,
  ) {
    return this.billing.subscribe({
      subjectType: 'SHOP',
      subjectId: shopId,
      ...body,
    });
  }

  @ShopScoped('billing.manage')
  @HttpCode(200)
  @Post('shops/:shopId/subscription/preview')
  async preview(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: ChangeSubscriptionDto,
  ) {
    const sub = await this.mustHave('SHOP', shopId);
    const lines = await this.billing.previewChange(sub.id, body);
    return { lines, dueNow: lines.reduce((s, l) => s + l.amount, 0) };
  }

  @ShopScoped('billing.manage')
  @Post('shops/:shopId/subscription/change')
  async change(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: ChangeSubscriptionDto,
  ) {
    return this.billing.change((await this.mustHave('SHOP', shopId)).id, body);
  }

  @ShopScoped('billing.manage')
  @HttpCode(204)
  @Post('shops/:shopId/subscription/cancel')
  async cancel(@Param('shopId', ParseUUIDPipe) shopId: string) {
    await this.billing.cancelAtPeriodEnd(
      (await this.mustHave('SHOP', shopId)).id,
    );
  }

  @ShopScoped('billing.manage')
  @Get('shops/:shopId/invoices')
  async shopInvoices(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.billing.invoices((await this.mustHave('SHOP', shopId)).id);
  }

  // --- Marketplace Plus (buyers) --- //
  @Firewall()
  @Get('me/subscription')
  async mine(@User() user: UserRawDto) {
    return {
      subscription: await this.billing.forSubject('USER', user.id),
      entitlements: await this.entitlements.get('USER', user.id),
    };
  }

  @Firewall()
  @Post('me/subscription')
  subscribeMe(@User() user: UserRawDto, @Body() body: SubscribeDto) {
    return this.billing.subscribe({
      subjectType: 'USER',
      subjectId: user.id,
      ...body,
    });
  }

  private async mustHave(subjectType: 'USER' | 'SHOP', subjectId: string) {
    const sub = await this.billing.forSubject(subjectType, subjectId);
    if (!sub) throw new NotFoundException('No active subscription');
    return sub;
  }
}
