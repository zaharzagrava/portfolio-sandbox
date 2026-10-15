import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Fatal_BadRequestError } from '@app/common/errors';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { BalanceQueryService } from '../application/balance-query.service';
import { BalanceQueryDto } from './ledger.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The shop guard answers a malformed shop id like an unknown shop (`404`); this route's contract says `400`
 * (contracts/http.md). It runs before the shop guard, so a malformed id never reaches the membership lookup.
 */
@Injectable()
export class ShopIdFormatGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const shopId = ctx
      .switchToHttp()
      .getRequest<{ params: { shopId?: string } }>().params.shopId;
    if (!shopId || !UUID.test(shopId))
      throw new Fatal_BadRequestError({ detail: 'shopId must be a UUID' });
    return true;
  }
}

/** `GET /shops/:shopId/balance` (S14 contracts/http.md): thin, one service call; the guard decides who may read. */
@ApiTags('finance')
@UseGuards(ShopIdFormatGuard)
@Controller('shops/:shopId')
export class BalanceController {
  constructor(private readonly balances: BalanceQueryService) {}

  @ShopScoped('payouts.read')
  @RateLimit('finance.balance.read')
  @Get('balance')
  balance(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query() query: BalanceQueryDto,
  ) {
    return this.balances.getShopBalance(shopId.toLowerCase(), query.currency);
  }
}
