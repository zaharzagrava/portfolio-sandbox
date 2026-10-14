import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  UseFilters,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
  AuctionPublic,
  BidHistoryPage,
} from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import { buildCacheControl } from '@app/infrastructure/cache';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { AuctionQueryService } from '../application/auction-query.service';
import { auctionBatchQuerySchema, bidHistoryQuerySchema } from './auction.dto';
import { AuctionExceptionFilter } from './auction.exception-filter';
import { AuctionZodPipe } from './auction-zod.pipe';

const CACHE_CONTROL = buildCacheControl({
  visibility: 'public',
  sMaxAgeSec: 1,
});

type BatchQuery = { productIds: string[] };
type HistoryQuery = { limit: number; cursor?: string };

/**
 * The public side of an auction (S21 contracts/http.md): anonymous, cacheable for a second at the edge, fail open on
 * the limiter so a rate-limit store outage never takes a page down. Public fields only.
 */
@ApiTags('auctions')
@UseFilters(AuctionExceptionFilter)
@Controller('auctions')
export class AuctionPublicController {
  constructor(private readonly queries: AuctionQueryService) {}

  @Firewall({ anonymous: true })
  @RateLimit('auctions.read.ip')
  @Header('Cache-Control', CACHE_CONTROL)
  @Get(':auctionId')
  get(
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
  ): Promise<AuctionPublic> {
    return this.queries.get(auctionId);
  }

  @Firewall({ anonymous: true })
  @RateLimit('auctions.read.ip')
  @Header('Cache-Control', CACHE_CONTROL)
  @Get()
  byProducts(
    @Query(new AuctionZodPipe(auctionBatchQuerySchema)) query: BatchQuery,
  ): Promise<AuctionPublic[]> {
    return this.queries.byProducts(query.productIds);
  }

  @Firewall({ anonymous: true })
  @RateLimit('auctions.read.ip')
  @Get(':auctionId/bids')
  history(
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
    @Query(new AuctionZodPipe(bidHistoryQuerySchema)) query: HistoryQuery,
  ): Promise<BidHistoryPage> {
    return this.queries.history(auctionId, query);
  }
}
