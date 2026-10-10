import {
  Controller,
  Get,
  Header,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ProductPublicView } from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import {
  VersionEtagInterceptor,
  buildCacheControl,
} from '@app/infrastructure/cache';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { PublicProductService } from '../application/public-product.service';
import { ProductNotFoundError } from '../domain/product-errors';
import { ProductIdPipe } from './product-id.pipe';

const FOUND = buildCacheControl({
  visibility: 'public',
  sMaxAgeSec: 15,
  staleWhileRevalidateSec: 30,
});
const NOT_FOUND = buildCacheControl({ visibility: 'public', sMaxAgeSec: 5 });

/**
 * Public product detail (R2). The id is validated before any cache or database access; the body carries `id` and
 * `version`, from which `VersionEtagInterceptor` derives `ETag: W/"<id>-v<version>"` and the `304`.
 */
@ApiTags('products')
@Controller('products')
export class PublicProductController {
  constructor(private readonly products: PublicProductService) {}

  @Firewall({ anonymous: true })
  @RateLimit('catalog.product-read.ip')
  @UseInterceptors(VersionEtagInterceptor)
  @Header('Cache-Control', FOUND)
  @Get(':productId')
  async get(
    @Param('productId', ProductIdPipe) productId: string,
  ): Promise<ProductPublicView> {
    const view = await this.products.getById(productId);
    if (!view) throw new ProductNotFoundError({ 'Cache-Control': NOT_FOUND });
    return view;
  }
}
