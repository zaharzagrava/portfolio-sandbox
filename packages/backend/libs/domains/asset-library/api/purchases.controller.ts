import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { PurchasesService } from '../application/purchases.service';
import { LIMITS } from '../domain/limits';
import { IntParamPipe } from './zod.pipes';

/** The buyer side (S31 FR-042): a session is the only credential; what a buyer holds is theirs alone. */
@ApiTags('digital')
@Controller()
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Firewall()
  @Get('me/purchases')
  list(
    @User() user: UserRawDto,
    @Query(
      'limit',
      new IntParamPipe('limit', 1, LIMITS.listMax, LIMITS.listDefault),
    )
    limit: number,
    @Query('cursor') cursor: string | undefined,
  ) {
    return this.purchases.list(user.id, { limit, cursor });
  }

  @Firewall()
  @HttpCode(200)
  @Post('me/purchases/:productId/download')
  download(@User() user: UserRawDto, @Param('productId') productId: string) {
    return this.purchases.download(user.id, productId);
  }
}
