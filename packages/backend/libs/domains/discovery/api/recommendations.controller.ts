import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { RecommendationsService } from '../application/recommendations.service';

@ApiTags('products')
@Controller('products')
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  /** Same for every viewer and rebuilt nightly → CDN-cacheable for 5 minutes. */
  @Firewall({ anonymous: true })
  @RateLimit('search.query')
  @Header('Cache-Control', 'public, max-age=60, s-maxage=300')
  @Get(':id/recommendations')
  boughtTogether(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit = '8',
  ) {
    return this.recommendations.boughtTogether(
      id,
      Math.min(Math.max(Number(limit) || 8, 1), 20),
    );
  }
}
