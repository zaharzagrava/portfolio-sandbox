import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RequiresShopEntitlement } from '@app/domains/billing';
import { User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { Idempotent } from '@app/infrastructure/idempotency';
import type {
  AuctionMember,
  AuctionPage,
} from '@marketplace-sandbox/contracts';
import { AuctionScheduleService } from '../application/auction-schedule.service';
import {
  auctionCreateRequestSchema,
  auctionListQuerySchema,
  type AuctionCreateRequest,
} from './auction.dto';
import { AuctionExceptionFilter } from './auction.exception-filter';
import { AuctionZodPipe } from './auction-zod.pipe';

/** Plain alias: a `z.output<...>` parameter type would make the global ValidationPipe try to instantiate it. */
type ListQuery = {
  status?: AuctionPage['items'][number]['status'];
  limit: number;
  cursor?: string;
};

/**
 * A seller's auctions (S21 contracts/http.md). Thin: a validated body, one application call, a DTO back. The shop comes
 * from the path and the guard checks the membership; another shop's auction is `404 auction_not_found`.
 */
@ApiTags('auctions')
@UseFilters(AuctionExceptionFilter)
@Controller()
export class AuctionSellerController {
  constructor(private readonly auctions: AuctionScheduleService) {}

  @RequiresShopEntitlement('auctions')
  @ShopScoped('products.write')
  @Idempotent()
  @Post('shops/:shopId/auctions')
  async create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body(new AuctionZodPipe(auctionCreateRequestSchema))
    body: AuctionCreateRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuctionMember> {
    const auction = await this.auctions.create(shopId, user.id, body);
    res.setHeader('Location', `/api/shops/${shopId}/auctions/${auction.id}`);
    return auction;
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/auctions')
  list(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query(new AuctionZodPipe(auctionListQuerySchema)) query: ListQuery,
  ): Promise<AuctionPage> {
    return this.auctions.list(shopId, query);
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/auctions/:auctionId')
  get(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
  ): Promise<AuctionMember> {
    return this.auctions.get(shopId, auctionId);
  }

  @ShopScoped('products.write')
  @HttpCode(HttpStatus.OK)
  @Post('shops/:shopId/auctions/:auctionId/cancel')
  cancel(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('auctionId', ParseUUIDPipe) auctionId: string,
    @User() user: AuthenticatedUser,
  ): Promise<AuctionMember> {
    return this.auctions.cancel(shopId, auctionId, user.id);
  }
}
