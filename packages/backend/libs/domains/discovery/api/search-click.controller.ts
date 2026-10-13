import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { SearchClickService } from '../application/search-click.service';

/** `POST /search/clicks` (S32 FR-053): anonymous, 300 a minute per address, one application call, an empty `202`. */
@ApiTags('search')
@Controller()
export class SearchClickController {
  constructor(private readonly clicks: SearchClickService) {}

  @Firewall({ anonymous: true })
  @RateLimit('discovery.search-click')
  @HttpCode(202)
  @Post('search/clicks')
  click(@Body() body: unknown): void {
    this.clicks.record(body);
  }
}
