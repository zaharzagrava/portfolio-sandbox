import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Firewall } from '@app/domains/identity';
import { RateLimitExempt } from '@app/infrastructure/rate-limit';
import { OAuthService } from '../application/oauth.service';

/**
 * Anonymous Shopify redirect target (the browser arrives from the provider without a bearer token). It is separate from
 * the shop-scoped routes (route-order note); the HMAC over the sorted query and the single-use `state` authenticate it.
 */
@ApiTags('integrations')
@Controller('integrations/shopify')
export class IntegrationOAuthController {
  constructor(private readonly oauth: OAuthService) {}

  @Firewall({ anonymous: true })
  @RateLimitExempt(
    'provider redirect: authenticated by HMAC and a single-use state; every failure is one identical 400',
  )
  @Get('callback')
  async callback(
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    const { location } = await this.oauth.handleCallback(query);
    res.redirect(302, location);
  }
}
