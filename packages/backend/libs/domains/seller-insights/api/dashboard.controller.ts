import { Controller, Get, Header, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { DashboardToday } from '@marketplace-sandbox/contracts';
import { ShopScoped } from '@app/domains/tenancy';
import { DashboardTodayService } from '../application/dashboard-today.service';

/** The first chart of the live dashboard; the per-second updates arrive over `shop:{id}:live` (S40 US5). */
@ApiTags('dashboard')
@Controller()
export class DashboardController {
  constructor(private readonly today: DashboardTodayService) {}

  @ShopScoped('shop.read')
  @Header('Cache-Control', 'private, no-store')
  @Get('shops/:shopId/dashboard/today')
  get(@Req() req: Request & { shopId: string }): Promise<DashboardToday> {
    return this.today.today(req.shopId);
  }
}
