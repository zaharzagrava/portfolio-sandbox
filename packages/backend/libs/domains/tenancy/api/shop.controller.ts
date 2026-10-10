import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ShopScoped } from './shop.guard';
import type { ShopRequest } from './shop.guard';
import { ShopService } from '../application/shop.service';
import { CreateShopDto, PageQueryDto, PatchShopDto } from './tenancy.dto';
import type { ShopRole } from '../domain/shop-types';

@ApiTags('shops')
@Controller()
export class ShopController {
  constructor(private readonly shops: ShopService) {}

  @Firewall()
  @RateLimit('tenancy.shop-create.user')
  @Post('shops')
  @HttpCode(201)
  create(@User() user: AuthenticatedUser, @Body() body: CreateShopDto) {
    return this.shops.create(user.id, body);
  }

  @Firewall()
  @Get('shops/mine')
  mine(@User() user: AuthenticatedUser, @Query() query: PageQueryDto) {
    return this.shops.mine(user.id, query);
  }

  @ShopScoped('shop.read')
  @Get('shops/:shopId')
  get(@Param('shopId', ParseUUIDPipe) shopId: string, @Req() req: ShopRequest) {
    return this.shops.get(shopId, req.shopRole as ShopRole);
  }

  @ShopScoped('shop.manage')
  @RateLimit('tenancy.shop-write.shop')
  @Patch('shops/:shopId')
  rename(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Req() req: ShopRequest,
    @Body() body: PatchShopDto,
  ) {
    return this.shops.rename(
      shopId,
      user.id,
      body.name,
      req.shopRole as ShopRole,
    );
  }
}
