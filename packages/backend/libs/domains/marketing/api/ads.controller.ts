import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { IsInt, IsString, IsUUID, Length, Min } from 'class-validator';
import { Firewall } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { AdsService } from '../application/ads.service';

export class CreateCampaignDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsString() @Length(1, 40) category: string;
  @ApiProperty() @IsInt() @Min(1) cpcCents: number;
  @ApiProperty() @IsInt() @Min(100) dailyBudgetCents: number;
}

@ApiTags('ads')
@Controller()
export class AdsController {
  constructor(
    private readonly ads: AdsService,
    private readonly config: ApiConfigService,
  ) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/ads/campaigns')
  create(@Param('shopId', ParseUUIDPipe) shopId: string, @Body() body: CreateCampaignDto) {
    return this.ads.createCampaign(shopId, body);
  }

  @Firewall({ anonymous: true })
  @Get('ads/sponsored')
  sponsored(@Query('category') category: string, @Req() req: Request & { user?: { id: string } }) {
    return this.ads.sponsored(category ?? 'all', req.user?.id ?? (req.headers['x-anonymous-id'] as string) ?? req.ip ?? '');
  }

  /** Always redirects (a fraud-filtered click still lands on the product); `no-store` so every click reaches us. */
  @Firewall({ anonymous: true, skipThrottle: true })
  @Get('ads/click/:token')
  async click(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const { redirectTo } = await this.ads.click(token, (req.headers['cf-connecting-ip'] as string) ?? req.ip ?? '');
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, `${this.config.get('front_host')}${redirectTo}`);
  }
}
