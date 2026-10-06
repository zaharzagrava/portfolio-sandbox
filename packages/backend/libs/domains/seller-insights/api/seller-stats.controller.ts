import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, User, UserRawDto, Role } from '@app/domains/identity';
import { SellerStatsService } from '../application/seller-stats.service';
import { SellerStatsQueryDto, SellerStatsResponseDto } from './seller-stats.dto';

@ApiTags('sellers')
@Controller('sellers')
export class SellerStatsController {
  constructor(private readonly sellerStatsService: SellerStatsService) { }

  /** Example: GET /api/sellers/me/stats?days=30 */
  @Firewall({ roles: [Role.SELLER] })
  @Get('me/stats')
  async myStats(
    @User() user: UserRawDto,
    @Query() query: SellerStatsQueryDto,
  ): Promise<SellerStatsResponseDto> {
    return this.sellerStatsService.getStats(user.id, query.days ?? 30);
  }
}
