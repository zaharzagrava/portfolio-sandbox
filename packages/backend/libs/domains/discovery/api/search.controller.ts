import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ProductSearchResponse } from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import type { RequestWithUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ProductSearchService } from '../application/product-search.service';

type SearchRequest = RequestWithUser & { clientIp?: string };

/**
 * `GET /products/search` (S32 FR-001): anonymous, rate limited per user or address, never cached by a shared cache
 * (`private, no-store`: the answer depends on the index state of the moment). One application call; the typed errors
 * of the domain are mapped to problem+json by the platform filter.
 */
@ApiTags('search')
@Controller()
export class SearchController {
  constructor(private readonly search: ProductSearchService) {}

  @Firewall({ anonymous: true })
  @RateLimit('discovery.search.query')
  @Header('Cache-Control', 'private, no-store')
  @Get('products/search')
  products(
    @Query() query: Record<string, unknown>,
    @Req() req: SearchRequest,
  ): Promise<ProductSearchResponse> {
    return this.search.search({
      query,
      surface: 'http',
      subject: req.user?.id ? `user:${req.user.id}` : `ip:${req.clientIp ?? req.ip}`,
    });
  }
}
