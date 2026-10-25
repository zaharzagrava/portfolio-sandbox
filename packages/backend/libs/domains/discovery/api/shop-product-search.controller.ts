import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { ShopProductSearchResponse } from '@marketplace-sandbox/contracts';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ShopProductSearchService } from '../application/shop-product-search.service';

/** One member of one shop is one rate-limit subject: a busy shop does not slow another, nor a colleague. */
const userAndShop = (req: Request): string | undefined => {
  const user = (req as Request & { user?: { id: string } }).user;
  return user ? `${user.id}:${req.params.shopId}` : undefined;
};

/** `GET /shops/:shopId/products/search` (S32 FR-046 to FR-050): members with `products.read`, one application call. */
@ApiTags('search')
@Controller()
export class ShopProductSearchController {
  constructor(private readonly search: ShopProductSearchService) {}

  @ShopScoped('products.read', { readWhileClosed: true })
  @RateLimit({ policy: 'discovery.shop-search', subject: userAndShop })
  @Get('shops/:shopId/products/search')
  shopProducts(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ShopProductSearchResponse> {
    return this.search.search(shopId, query);
  }
}
