import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { Firewall } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { WidgetService } from '../application/widget.service';

export class CreateSiteDto {
  @ApiProperty({ example: ['https://www.my-shop.com'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  origins: string[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  featuredProductIds?: string[];
}

export class IdentifyDto {
  @ApiProperty() @IsString() key: string;
  @ApiProperty() @IsString() token: string;
}

export class KillSwitchDto {
  @ApiProperty() @IsBoolean() on: boolean;
}

@ApiTags('widget')
@Controller()
export class WidgetController {
  constructor(private readonly widget: WidgetService) {}

  @ShopScoped('shop.manage')
  @Post('shops/:shopId/widget/sites')
  create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: CreateSiteDto,
  ) {
    return this.widget.createSite(
      shopId,
      body.origins,
      body.featuredProductIds,
    );
  }

  @ShopScoped('shop.manage')
  @Put('shops/:shopId/widget/sites/:siteId/kill-switch')
  @HttpCode(204)
  kill(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: KillSwitchDto,
  ) {
    return this.widget.setKillSwitch(shopId, siteId, body.on);
  }

  /**
   * Edge-cacheable per (key, origin): `Vary: Origin` + the CORS header echoes
   * only that registered origin (never `*`, never credentials).
   */
  @Firewall({ anonymous: true })
  @Get('widget/v1/config')
  async config(
    @Query('key') key: string,
    @Headers('origin') origin: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const site = await this.widget.authorize(key ?? '', origin);
    res.setHeader('Access-Control-Allow-Origin', origin!);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    return this.widget.config_(site);
  }

  @Firewall({ anonymous: true })
  @RateLimit('auth.login.ip')
  @Post('widget/v1/identify')
  @HttpCode(200)
  async identify(
    @Body() body: IdentifyDto,
    @Headers('origin') origin: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const site = await this.widget.authorize(body.key, origin);
    res.setHeader('Access-Control-Allow-Origin', origin!);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    return this.widget.identify(site, body.token);
  }

  /**
   * The iframe document (the FE app mounts into it in phase 2). The only route
   * whose CSP allows framing - by exactly this site's origins; the global
   * policy everywhere else is `frame-ancestors 'none'` (clickjacking).
   */
  @Firewall({ anonymous: true })
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Get('widget/v1/embed')
  async embed(@Query('key') key: string, @Res() res: Response) {
    const site = await this.widget.site(key ?? '');
    if (site.killSwitch) return res.status(410).send('');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; ${this.widget.frameAncestors(site)}`,
    );
    res.removeHeader('X-Frame-Options'); // superseded by frame-ancestors; helmet's SAMEORIGIN would block the shop's page
    res.send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Checkout</title></head><body><div id="widget-root" data-site="${encodeURIComponent(key)}"></div><script src="/widget/v1/app.js"></script></body></html>`,
    );
  }
}
