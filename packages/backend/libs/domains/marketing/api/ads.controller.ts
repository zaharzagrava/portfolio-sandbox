import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  adBillingQuerySchema,
  adCampaignListQuerySchema,
  createAdCampaignRequestSchema,
  sponsoredQuerySchema,
  type AdBillingPage,
  type AdCampaign,
  type AdCampaignDetail,
  type AdCampaignPage,
  type AdCampaignStatus,
  type CreateAdCampaignRequest,
  type SponsoredSlotsResponse,
} from '@marketplace-sandbox/contracts';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { ApiConfigService } from '@app/common/config';
import { RateLimit, RateLimitExempt } from '@app/infrastructure/rate-limit';
import { BillingStatementService } from '../application/billing-statement.service';
import { CampaignCommandService } from '../application/campaign-command.service';
import { CampaignQueryService } from '../application/campaign-query.service';
import { ClickService } from '../application/click.service';
import { ServingService } from '../application/serving.service';
import { AdsZodPipe } from './ads-zod.pipe';

/** Plain aliases: a `z.output<...>` parameter type would make the global ValidationPipe try to instantiate it. */
type ListQuery = { status?: AdCampaignStatus; limit: number; cursor?: string };
type SponsoredQuery = { category: string; limit: number };
type BillingQuery = {
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
};

const ANONYMOUS_ID_MAX = 128;

/**
 * Who is looking, as a kind-prefixed identity for the keyed viewer hash (FR-013): the session user, else the
 * client-supplied anonymous id (untrusted, it only feeds the hash), else the address the platform resolved from its
 * trusted proxies (never a header read here).
 */
type PlatformRequest = Request & { user?: { id: string }; clientIp?: string };

/** The address the platform resolved from `trusted_proxies`; a header is never read here (FR-024). */
const clientAddress = (req: PlatformRequest): string =>
  req.clientIp ?? req.ip ?? '';

const viewerIdentity = (req: PlatformRequest): string => {
  if (req.user?.id) return `user:${req.user.id}`;
  const anonymous = req.headers['x-anonymous-id'];
  const value = Array.isArray(anonymous) ? anonymous[0] : anonymous;
  if (value) return `anon:${value.slice(0, ANONYMOUS_ID_MAX)}`;
  return `ip:${clientAddress(req)}`;
};

/** A prefetch or a link scanner must not count as a click (FR-023). */
const isPrefetch = (req: Request): boolean =>
  req.method === 'HEAD' ||
  [req.headers['sec-purpose'], req.headers['purpose']].some(
    (value) => typeof value === 'string' && /prefetch|prerender/i.test(value),
  );

/**
 * Sponsored listings, HTTP side (S36, apps/core). Thin: a validated DTO, one service call, a DTO back (II). Campaign
 * routes are shop-scoped (`ShopScoped`, a non-member gets `404`); money-spending actions need `shop.manage`, reads
 * `products.read`. Every error is problem+json from the global filter.
 */
@ApiTags('ads')
@Controller()
export class AdsController {
  constructor(
    private readonly commands: CampaignCommandService,
    private readonly queries: CampaignQueryService,
    private readonly statements: BillingStatementService,
    private readonly serving: ServingService,
    private readonly clicks: ClickService,
    private readonly config: ApiConfigService,
  ) {}

  /**
   * Public, per shopper and never shared: `private, no-store` (a shared cache would replay one impression id to many
   * shoppers and starve billing). The limiter fails open: a store outage must not take the storefront down.
   */
  @Firewall({ anonymous: true })
  @RateLimit('marketing.ads-serve.ip')
  @Get('ads/sponsored')
  sponsored(
    @Query(new AdsZodPipe(sponsoredQuerySchema)) query: SponsoredQuery,
    @Req() req: PlatformRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SponsoredSlotsResponse> {
    res.setHeader('Cache-Control', 'private, no-store');
    return this.serving.serve({
      category: query.category,
      limit: query.limit,
      viewer: viewerIdentity(req),
    });
  }

  /**
   * Always a `302` (FR-020): no limiter (a limiter must never cost the shopper the redirect), no error status caused by a
   * store, `no-store` so every click reaches us. The target is built from the configured storefront origin and the signed
   * product id only, so a query parameter or a spoofed `Host` changes nothing (FR-021). It is a `GET` that records a click:
   * the accepted exception to V.5, made safe by the per-impression marker, `HEAD`/prefetch not counting and the spam filter.
   */
  @Firewall({ anonymous: true })
  @RateLimitExempt(
    'a limiter must never cost the shopper the redirect; the spam filter decides what is billable (S36 FR-020)',
  )
  @Get('ads/click/:token')
  async click(
    @Param('token') token: string,
    @Req() req: PlatformRequest,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.clicks.handle({
      token,
      address: clientAddress(req),
      countable: !isPrefetch(req),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(HttpStatus.FOUND, this.locationOf(result));
  }

  private locationOf(
    result: { target: 'product'; productId: string } | { target: 'home' },
  ): string {
    let origin: string;
    try {
      origin = new URL(this.config.get('front_host')).origin;
    } catch {
      return '/';
    }
    return result.target === 'product'
      ? `${origin}/p/${result.productId}?ad=1`
      : `${origin}/`;
  }

  @ShopScoped('shop.manage')
  @RateLimit('marketing.ads-write.shop')
  @Post('shops/:shopId/ads/campaigns')
  create(
    @Param('shopId') shopId: string,
    @User() user: UserRawDto,
    @Body(new AdsZodPipe(createAdCampaignRequestSchema))
    body: CreateAdCampaignRequest,
  ): Promise<AdCampaign> {
    return this.commands.create(shopId.toLowerCase(), user.id, body);
  }

  @ShopScoped('products.read')
  @RateLimit('marketing.ads-read.shop')
  @Get('shops/:shopId/ads/campaigns')
  list(
    @Param('shopId') shopId: string,
    @Query(new AdsZodPipe(adCampaignListQuerySchema)) query: ListQuery,
  ): Promise<AdCampaignPage> {
    return this.queries.list(shopId.toLowerCase(), query);
  }

  @ShopScoped('products.read')
  @RateLimit('marketing.ads-read.shop')
  @Get('shops/:shopId/ads/campaigns/:campaignId')
  get(
    @Param('shopId') shopId: string,
    @Param('campaignId') campaignId: string,
  ): Promise<AdCampaignDetail> {
    return this.queries.get(shopId.toLowerCase(), campaignId);
  }

  /** What the advertiser is charged: owners and admins only (`payouts.read`). */
  @ShopScoped('payouts.read')
  @RateLimit('marketing.ads-read.shop')
  @Get('shops/:shopId/ads/campaigns/:campaignId/billing')
  billing(
    @Param('shopId') shopId: string,
    @Param('campaignId') campaignId: string,
    @Query(new AdsZodPipe(adBillingQuerySchema)) query: BillingQuery,
  ): Promise<AdBillingPage> {
    return this.statements.statement(shopId.toLowerCase(), campaignId, query);
  }

  @ShopScoped('shop.manage')
  @RateLimit('marketing.ads-write.shop')
  @HttpCode(HttpStatus.OK)
  @Post('shops/:shopId/ads/campaigns/:campaignId/pause')
  pause(
    @Param('shopId') shopId: string,
    @Param('campaignId') campaignId: string,
    @User() user: UserRawDto,
  ): Promise<AdCampaign> {
    return this.commands.transition(
      shopId.toLowerCase(),
      campaignId,
      'pause',
      user.id,
    );
  }

  @ShopScoped('shop.manage')
  @RateLimit('marketing.ads-write.shop')
  @HttpCode(HttpStatus.OK)
  @Post('shops/:shopId/ads/campaigns/:campaignId/resume')
  resume(
    @Param('shopId') shopId: string,
    @Param('campaignId') campaignId: string,
    @User() user: UserRawDto,
  ): Promise<AdCampaign> {
    return this.commands.transition(
      shopId.toLowerCase(),
      campaignId,
      'resume',
      user.id,
    );
  }

  @ShopScoped('shop.manage')
  @RateLimit('marketing.ads-write.shop')
  @HttpCode(HttpStatus.OK)
  @Post('shops/:shopId/ads/campaigns/:campaignId/end')
  end(
    @Param('shopId') shopId: string,
    @Param('campaignId') campaignId: string,
    @User() user: UserRawDto,
  ): Promise<AdCampaign> {
    return this.commands.transition(
      shopId.toLowerCase(),
      campaignId,
      'end',
      user.id,
    );
  }
}
