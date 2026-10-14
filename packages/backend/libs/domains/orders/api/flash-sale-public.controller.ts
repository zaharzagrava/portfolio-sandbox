import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { FLASH_BATCH_MAX_PRODUCTS } from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import { buildCacheControl } from '@app/infrastructure/cache';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { FlashPublicService } from '../application/flash-public.service';
import type { FlashSalePublic } from './flash-sale.dto';
import { FlashZodPipe } from './flash-zod.pipe';

const CACHE_CONTROL = buildCacheControl({
  visibility: 'public',
  sMaxAgeSec: 1,
});

/** `?productIds=<uuid>,<uuid>`: 1 to 100 distinct-able ids, each a uuid. */
const batchQuerySchema = z
  .object({
    productIds: z
      .string()
      .transform((v) => v.split(','))
      .pipe(z.array(z.string().uuid()).min(1).max(FLASH_BATCH_MAX_PRODUCTS)),
  })
  .strict();

type BatchQuery = { productIds: string[] };

/**
 * The countdown and the approximate remaining count of a drop (S11 contracts/http.md), anonymous and cacheable for a
 * second at the edge. Fail open on the limiter: a rate-limit store outage must not take the drop page down.
 */
@ApiTags('flash-sales')
@Controller('flash-sales')
export class FlashSalePublicController {
  constructor(private readonly publicSales: FlashPublicService) {}

  @Firewall({ anonymous: true })
  @RateLimit('orders.flash-sale-read.ip')
  @Header('Cache-Control', CACHE_CONTROL)
  @Get(':saleId')
  get(
    @Param('saleId', ParseUUIDPipe) saleId: string,
  ): Promise<FlashSalePublic> {
    return this.publicSales.get(saleId);
  }

  @Firewall({ anonymous: true })
  @RateLimit('orders.flash-sale-read.ip')
  @Header('Cache-Control', CACHE_CONTROL)
  @Get()
  byProducts(
    @Query(new FlashZodPipe(batchQuerySchema)) query: BatchQuery,
  ): Promise<FlashSalePublic[]> {
    return this.publicSales.byProducts(query.productIds);
  }
}
