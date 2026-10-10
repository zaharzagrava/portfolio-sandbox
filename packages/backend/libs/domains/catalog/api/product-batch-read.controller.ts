import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ProductBatchItem } from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { PublicProductService } from '../application/public-product.service';
import { ProductValidationError } from '../domain/product-errors';
import { parseBatchIds } from '../domain/product-input';

/**
 * Batch product reads for the BFF's DataLoaders (constitution IX.7 R2): 20 products in a GraphQL list -> one call.
 * Public, non-sensitive fields only; results in request order with `null` for what is not visible. No query here: one
 * service call.
 */
@ApiTags('batch')
@Controller('batch')
export class ProductBatchReadController {
  constructor(private readonly products: PublicProductService) {}

  @Firewall({ anonymous: true })
  @RateLimit('catalog.batch-read.ip')
  @Header('Cache-Control', 'public, max-age=10')
  @Get('products')
  async batch(
    @Query('ids') raw: unknown,
  ): Promise<Array<ProductBatchItem | null>> {
    const parsed = parseBatchIds(raw);
    if (!parsed.ok) throw new ProductValidationError(parsed.fields);
    return this.products.getBatch(parsed.value);
  }
}
