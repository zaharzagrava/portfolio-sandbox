import { BadRequestException, Controller, Get, Header, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { LeaderboardService } from '../application/leaderboard.service';
import { ShopDashboardService } from '../application/shop-dashboard.service';
import type { PeriodKind } from '../domain/periods';

const kindOf = (period?: string): PeriodKind => {
  if (period === undefined || period === 'week') return 'week';
  if (period === 'month') return 'month';
  throw new BadRequestException('period: week | month');
};

@ApiTags('leaderboards')
@Controller()
export class LeaderboardsController {
  constructor(
    private readonly leaderboards: LeaderboardService,
    private readonly dashboard: ShopDashboardService,
  ) {}

  /** GET /api/leaderboards?period=week&id=2026-W40&category=electronics */
  @Firewall({ anonymous: true })
  @Header('Cache-Control', 'public, max-age=10, s-maxage=30')
  @Get('leaderboards')
  top(@Query('period') period?: string, @Query('id') id?: string, @Query('category') category?: string, @Query('limit') limit = '20') {
    return this.leaderboards.top(kindOf(period), id, category, Math.min(Math.max(Number(limit) || 20, 1), 100));
  }

  @Firewall({ anonymous: true })
  @Get('leaderboards/shops/:shopId')
  rank(@Param('shopId', ParseUUIDPipe) shopId: string, @Query('period') period?: string, @Query('id') id?: string, @Query('category') category?: string) {
    return this.leaderboards.rank(shopId, kindOf(period), id, category);
  }

  /** Initial chart for the live dashboard; the per-second updates arrive over SSE `shop:{id}:live`. */
  @ShopScoped('shop.read')
  @Get('shops/:shopId/dashboard/today')
  today(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.dashboard.today(shopId);
  }
}
