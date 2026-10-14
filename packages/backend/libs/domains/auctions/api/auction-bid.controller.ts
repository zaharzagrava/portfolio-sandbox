import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseFilters,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { BidResult, MyBid } from '@marketplace-sandbox/contracts';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { BidService } from '../application/bid.service';
import { bidRequestSchema, type BidRequest } from './auction.dto';
import { AuctionExceptionFilter } from './auction.exception-filter';
import { AuctionZodPipe } from './auction-zod.pipe';

/**
 * Bidding (S21 contracts/http.md). Thin: a validated body, one application call. The server's clock decides every time
 * question; no client time is read. A bid needs an `Idempotency-Key`, a replay answers the stored result for the same
 * principal only, and the limiter is fail closed (a store outage is `503 bid_unavailable`).
 */
@ApiTags('auctions')
@UseFilters(AuctionExceptionFilter)
@Controller()
export class AuctionBidController {
  constructor(private readonly bids: BidService) {}

  @Firewall()
  @RateLimit('auction.bid')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @Post('auctions/:auctionId/bids')
  bid(
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
    @User() user: AuthenticatedUser,
    @Body(new AuctionZodPipe(bidRequestSchema)) body: BidRequest,
  ): Promise<BidResult> {
    return this.bids.placeBid(auctionId, user.id, body.maxAmountMinor);
  }

  @Firewall()
  @Get('auctions/:auctionId/my-bid')
  myBid(
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
    @User() user: AuthenticatedUser,
  ): Promise<MyBid> {
    return this.bids.myBid(auctionId, user.id);
  }
}
