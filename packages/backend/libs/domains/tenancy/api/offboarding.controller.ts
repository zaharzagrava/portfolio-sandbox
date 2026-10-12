import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ShopScoped } from './shop.guard';
import { ShopLifecycleService } from '../application/shop-lifecycle.service';
import { OffboardShopDto } from './tenancy.dto';

/**
 * Closing a shop and taking the data with you (FR-060, FR-061). Only the owner holds `shop.delete` and `shop.export`;
 * the status gate lets both through while the shop is suspended or closing.
 */
@ApiTags('shops')
@Controller()
export class OffboardingController {
  constructor(private readonly lifecycle: ShopLifecycleService) {}

  @ShopScoped('shop.delete')
  @RateLimit('tenancy.shop-write.shop')
  @Post('shops/:shopId/offboarding')
  @HttpCode(200)
  start(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body() body: OffboardShopDto,
  ) {
    return this.lifecycle.startOffboarding(shopId, user.id, body.confirmSlug);
  }

  @ShopScoped('shop.delete')
  @RateLimit('tenancy.shop-write.shop')
  @Delete('shops/:shopId/offboarding')
  @HttpCode(200)
  cancel(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
  ) {
    return this.lifecycle.cancelOffboarding(shopId, user.id);
  }

  @ShopScoped('shop.export')
  @Header('Cache-Control', 'no-store')
  @Get('shops/:shopId/export')
  export(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
  ) {
    return this.lifecycle.export(shopId, user.id);
  }
}
