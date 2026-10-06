import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { RequiresShopEntitlement } from '@app/domains/billing';
import { AuctionService } from '../application/auction.service';
import { CreateAuctionDto, PlaceBidDto } from './auctions.dto';

@ApiTags('auctions')
@Controller()
export class AuctionsController {
  constructor(
    private readonly auctions: AuctionService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  @RequiresShopEntitlement('auctions')
  @ShopScoped('products.write')
  @Post('shops/:shopId/auctions')
  create(@Param('shopId', ParseUUIDPipe) shopId: string, @Body() body: CreateAuctionDto) {
    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(body.endsAt);
    if (endsAt <= startsAt) throw new BadRequestException('endsAt must be after startsAt');
    return this.auctions.create(shopId, { ...body, startsAt, endsAt });
  }

  /** Live state from Redis (+ server time for countdown sync); updates over SSE `auction:<id>`. */
  @Firewall({ anonymous: true, skipThrottle: true })
  @Get('auctions/:auctionId')
  view(@Param('auctionId', ParseUUIDPipe) auctionId: string) {
    return this.auctions.view(auctionId);
  }

  @Firewall()
  @RateLimit('auction.bid')
  @HttpCode(200)
  @Post('auctions/:auctionId/bids')
  bid(@Param('auctionId', ParseUUIDPipe) auctionId: string, @User() user: UserRawDto, @Body() body: PlaceBidDto) {
    return this.auctions.placeBid(auctionId, user.id, body.maxAmount);
  }

  /** Public bid history (amounts, not other bidders' maxima). */
  @Firewall({ anonymous: true })
  @Get('auctions/:auctionId/bids')
  history(@Param('auctionId', ParseUUIDPipe) auctionId: string) {
    return this.sequelize.query(
      `SELECT "priceAfter" AS price, outcome, "createdAt" FROM "Bid" WHERE "auctionId" = :auctionId AND outcome IN ('leading','outbid')
       ORDER BY version DESC LIMIT 50`,
      { type: QueryTypes.SELECT, replacements: { auctionId } },
    );
  }
}
