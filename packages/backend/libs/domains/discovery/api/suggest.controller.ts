import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { SuggestResponse } from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { SuggestService } from '../application/suggest.service';

/**
 * `GET /suggest` (S33 FR-001): anonymous and identical for everyone, so a complete answer may sit in a shared cache for a
 * minute (`public, max-age=60, s-maxage=60`); a degraded answer and every error are `no-store`, otherwise one engine
 * hiccup would be pinned at the edge for every user of that prefix. The header is set to `no-store` first and replaced
 * only when the service returns a complete answer, so a thrown error keeps it. One application call.
 */
@ApiTags('search')
@Controller('suggest')
export class SuggestController {
  constructor(private readonly suggestions: SuggestService) {}

  @Firewall({ anonymous: true })
  @RateLimit('discovery.suggest')
  @Get()
  async suggest(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SuggestResponse> {
    res.setHeader('Cache-Control', 'no-store');
    const body = await this.suggestions.suggest(query);
    if (body.degraded.length === 0)
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    return body;
  }
}
