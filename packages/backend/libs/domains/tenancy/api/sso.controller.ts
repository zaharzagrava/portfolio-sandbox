import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ApiTags } from '@nestjs/swagger';
import { ShopScoped } from './shop.guard';
import { ShopSsoService } from '../application/shop-sso.service';
import { ShopSsoConfigDto } from './tenancy.dto';

/**
 * Shop identity provider configuration. Still the pre-S03 behaviour (US6 of the S03 plan rebuilds it: discovery,
 * context-bound secrets, registry wiring); only the permission moved to the new matrix (OWNER only).
 */
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
  @Put('shops/:shopId/sso')
  configureSso(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: ShopSsoConfigDto,
  ) {
    return this.sso.configure(
      shopId,
      body.issuer,
      body.clientId,
      body.clientSecret,
    );
  }
}
