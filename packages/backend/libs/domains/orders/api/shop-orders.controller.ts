import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ShopScoped } from '@app/domains/tenancy';
import { OrderQueryService } from '../application/order-query.service';
import { ListShopOrdersQueryDto } from './orders.dto';

/** The seller's order list: one shop's slice, for any member holding `orders.read`. */
@ApiTags('orders')
@Controller()
export class ShopOrdersController {
  constructor(private readonly queries: OrderQueryService) {}

  @ShopScoped('orders.read', { readWhileClosed: true })
  @Get('shops/:shopId/orders')
  list(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query() query: ListShopOrdersQueryDto,
  ) {
    return this.queries.getOrdersForShop(shopId, {
      status: query.status,
      limit: query.limit,
      cursor: query.cursor,
    });
  }
}
