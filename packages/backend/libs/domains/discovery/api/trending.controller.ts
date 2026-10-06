import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall } from '@app/domains/identity';
import { TrendingService } from '../application/trending.service';

@ApiTags('products')
@Controller('trending')
export class TrendingController {
  constructor(private readonly trending: TrendingService) {}

  @Firewall({ anonymous: true, skipThrottle: true })
  @Header('Cache-Control', 'public, max-age=30, s-maxage=30')
  @Get()
  get(@Query('category') category = 'all') {
    return this.trending.trending(category.slice(0, 40));
  }
}
