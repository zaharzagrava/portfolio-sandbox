import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { TrendingResponse } from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { TrendingService } from '../application/trending.service';

/**
 * `GET /api/trending` (S35 FR-001): anonymous and identical for every caller, so a complete answer may sit in a shared
 * cache (`public, max-age=30, s-maxage=30`). Every error stays `no-store`: the header is set to `no-store` first and
 * replaced only when the service returns a body, so a thrown problem keeps it. One application call.
 */
@ApiTags('products')
@Controller('trending')
export class TrendingController {
  constructor(private readonly trending: TrendingService) {}

  @Firewall({ anonymous: true })
  @RateLimit('discovery.trending')
  @Get()
  async get(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TrendingResponse> {
    res.setHeader('Cache-Control', 'no-store');
    const body = await this.trending.trending(query);
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30');
    return body;
  }
}
