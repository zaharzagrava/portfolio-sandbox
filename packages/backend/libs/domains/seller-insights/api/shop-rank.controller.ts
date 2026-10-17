import { Controller, Get, Header, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { ShopRank } from '@marketplace-sandbox/contracts';
import { ShopScoped } from '@app/domains/tenancy';
import { ShopRankService } from '../application/shop-rank.service';
import { parseRankQuery } from './query-dtos';

/** A shop's own rank (S40 US3): members only; revenue never reaches a non-member. */
@ApiTags('leaderboards')
@Controller()
export class ShopRankController {
  constructor(private readonly ranks: ShopRankService) {}

  /** GET /api/shops/:shopId/rank?period=week&id=2026-W40&category=electronics */
  @ShopScoped('shop.read')
  @Header('Cache-Control', 'private, no-store')
  @Get('shops/:shopId/rank')
  rank(@Req() req: Request & { shopId: string }): Promise<ShopRank> {
    return this.ranks.rank(req.shopId, parseRankQuery(req.query));
  }
}
