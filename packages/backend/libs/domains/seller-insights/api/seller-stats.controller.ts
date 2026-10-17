import { Controller, Get, Header, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { SellerStats } from '@marketplace-sandbox/contracts';
import { ShopScoped } from '@app/domains/tenancy';
import { SellerStatsService } from '../application/seller-stats.service';
import { parseStatsQuery } from './query-dtos';

/** A shop's sales stats over the last N days (S40 US6); replaces the per-user `GET /sellers/me/stats`. */
@ApiTags('shops')
@Controller()
export class SellerStatsController {
  constructor(private readonly stats: SellerStatsService) {}

  /** GET /api/shops/:shopId/stats?days=30 */
  @ShopScoped('shop.read')
  @Header('Cache-Control', 'private, no-store')
  @Get('shops/:shopId/stats')
  get(@Req() req: Request & { shopId: string }): Promise<SellerStats> {
    return this.stats.stats(req.shopId, parseStatsQuery(req.query).days);
  }
}
