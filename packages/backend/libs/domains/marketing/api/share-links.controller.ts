import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Response } from 'express';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { ShareLinkService } from '../application/share-link.service';

export class CreateLinkDto {
  @ApiProperty()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  destination: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  alias?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  ttlDays?: number;
}

@ApiTags('share-links')
@Controller()
export class ShareLinksController {
  constructor(private readonly links: ShareLinkService) {}

  @Firewall()
  @RateLimit('discussion.write')
  @Post('links')
  create(@User() user: UserRawDto, @Body() body: CreateLinkDto) {
    return this.links.create(
      user.id,
      body.destination,
      body.alias,
      body.ttlDays,
    );
  }

  @Firewall()
  @Get('links')
  mine(@User() user: UserRawDto) {
    return this.links.mine(user.id);
  }

  @Firewall()
  @Get('links/:code/stats')
  stats(@User() user: UserRawDto, @Param('code') code: string) {
    return this.links.stats(code, user.id);
  }

  /**
   * Origin redirect (the edge worker serves cached ones). 302 + short shared
   * cache: a viral link is answered by the CDN for 10 s at a time, edits still
   * propagate quickly, and the `ref` parameter carries attribution to checkout.
   */
  @Firewall({ anonymous: true, skipThrottle: true })
  @Get('l/:code')
  async redirect(
    @Param('code') code: string,
    @Headers('cf-ipcountry') country: string | undefined,
    @Headers('referer') referer: string | undefined,
    @Headers('x-edge-click-recorded') edgeRecorded: string | undefined,
    @Res() res: Response,
  ) {
    const link = await this.links.resolve(code);
    if (!link) throw new NotFoundException('Link not found');
    if (edgeRecorded !== '1')
      this.links.recordClick(code, { country, referer });
    const target = new URL(link.destination);
    target.searchParams.set('ref', code);
    res.setHeader('Cache-Control', 'public, s-maxage=10');
    res.redirect(302, target.toString());
  }
}
