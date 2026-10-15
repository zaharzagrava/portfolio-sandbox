import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { PayoutQueryService } from '../application/payout-query.service';
import { ShopIdFormatGuard } from './balance.controller';
import { PayoutPageQueryDto } from './payout.dto';

/**
 * The seller's payouts (S15 contracts/http.md): a member with `payouts.read` sees their own shop's payouts only.
 * Thin: one service call per route. `upcoming` is declared before `:payoutId` so it is never read as an id.
 */
@ApiTags('payouts')
@UseGuards(ShopIdFormatGuard)
@Controller('shops/:shopId/payouts')
export class PayoutsController {
  constructor(private readonly queries: PayoutQueryService) {}

  @ShopScoped('payouts.read')
  @RateLimit('finance.payouts.read')
  @Get()
  list(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query() query: PayoutPageQueryDto,
  ) {
    return this.queries.listForShop(shopId.toLowerCase(), query);
  }

  @ShopScoped('payouts.read')
  @RateLimit('finance.payouts.read')
  @Get('upcoming')
  upcoming(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.queries.upcoming(shopId.toLowerCase());
  }

  @ShopScoped('payouts.read')
  @RateLimit('finance.payouts.read')
  @Get(':payoutId')
  one(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('payoutId', ParseUUIDPipe) payoutId: string,
  ) {
    return this.queries.getForShop(
      shopId.toLowerCase(),
      payoutId.toLowerCase(),
    );
  }
}
