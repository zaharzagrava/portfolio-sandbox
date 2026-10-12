import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ApiTags } from '@nestjs/swagger';
import { ShopScoped } from './shop.guard';
import { ShopSsoService } from '../application/shop-sso.service';
import { ShopSsoConfigDto } from './tenancy.dto';

/** Company sign-in per shop (FR-040 to FR-043). Configuration is the owner's: `sso.manage`. */
@ApiTags('shops')
@Controller()
export class SsoController {
  constructor(private readonly sso: ShopSsoService) {}

  /** Anonymous: the sign-in page asks whether a shop has company sign-in. */
  @Firewall({ anonymous: true })
  @RateLimit('tenancy.sso-lookup.ip')
  @Get('shops/by-slug/:slug/sso')
  lookup(@Param('slug') slug: string) {
    return this.sso.publicLookup(slug.toLowerCase());
  }

  @ShopScoped('sso.manage')
  @RateLimit('tenancy.shop-write.shop')
  @Put('shops/:shopId/sso')
  configureSso(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body() body: ShopSsoConfigDto,
  ) {
    return this.sso.configure(shopId, user.id, body);
  }

  @ShopScoped('sso.manage')
  @Get('shops/:shopId/sso')
  read(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.sso.get(shopId);
  }

  @ShopScoped('sso.manage')
  @RateLimit('tenancy.shop-write.shop')
  @Delete('shops/:shopId/sso')
  @HttpCode(204)
  async remove(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
  ): Promise<void> {
    await this.sso.remove(shopId, user.id);
  }
}
