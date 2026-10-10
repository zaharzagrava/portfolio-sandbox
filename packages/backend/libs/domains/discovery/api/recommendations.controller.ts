import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { RecommendationsResponse } from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { RecommendationsService } from '../application/recommendations.service';

/**
 * `GET /products/:productId/recommendations` (S34 FR-001): anonymous and identical for every caller, so a complete answer
 * may sit in a shared cache (`public, max-age=60, s-maxage=300`). Every error stays `no-store`: the header is set to
 * `no-store` first and replaced only when the service returns a body, so a thrown problem keeps it. One application call.
 */
@ApiTags('products')
@Controller('products')
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Firewall({ anonymous: true })
  @RateLimit('discovery.recommendations')
  @Get(':productId/recommendations')
  async boughtTogether(
    @Param('productId') productId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RecommendationsResponse> {
    res.setHeader('Cache-Control', 'no-store');
    const body = await this.recommendations.boughtTogether(productId, query);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return body;
  }
}
