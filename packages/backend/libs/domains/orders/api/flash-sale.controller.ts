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
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { FlashSaleService } from '../application/flash-sale.service';
import {
  flashSaleCreateRequestSchema,
  flashSaleListQuerySchema,
  type FlashSaleCreateRequest,
  type FlashSaleMember,
  type FlashSalePage,
} from './flash-sale.dto';
import { FlashZodPipe } from './flash-zod.pipe';

/** Plain alias: a `z.output<...>` parameter type would make the global ValidationPipe try to instantiate it. */
type ListQuery = {
  status?: FlashSalePage['items'][number]['status'];
  limit: number;
  cursor?: string;
};

/**
 * A seller's drops (S11 contracts/http.md). Thin: a validated body, one application call, a DTO back. The shop comes
 * from the path and the guard checks the membership; another shop's sale is `404`.
 */
@ApiTags('flash-sales')
@Controller()
export class FlashSaleController {
  constructor(private readonly sales: FlashSaleService) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/flash-sales')
  async create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body(new FlashZodPipe(flashSaleCreateRequestSchema))
    body: FlashSaleCreateRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FlashSaleMember> {
    const sale = await this.sales.create(shopId, body, user.id);
    res.setHeader('Location', `/api/shops/${shopId}/flash-sales/${sale.id}`);
    return sale;
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/flash-sales')
  list(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query(new FlashZodPipe(flashSaleListQuerySchema)) query: ListQuery,
  ): Promise<FlashSalePage> {
    return this.sales.list(shopId, query);
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/flash-sales/:saleId')
  get(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('saleId', ParseUUIDPipe) saleId: string,
  ): Promise<FlashSaleMember> {
    return this.sales.get(shopId, saleId);
  }

  @ShopScoped('products.write')
  @HttpCode(HttpStatus.OK)
  @Post('shops/:shopId/flash-sales/:saleId/cancel')
  cancel(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @User() user: AuthenticatedUser,
  ): Promise<FlashSaleMember> {
    return this.sales.cancel(shopId, saleId, user.id);
  }
}
