import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/sequelize';
import { ShopScoped } from '@app/domains/tenancy';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { LedgerService } from '../application/ledger.service';
import { shopAccount } from '../domain/accounts';
import Payout from '../infra/models/payout.model';
import { BALANCES_KEY } from '../infra/balance.projector';

@ApiTags('finance')
@Controller('shops/:shopId')
export class FinanceController {
  constructor(
    private readonly redis: RedisService,
    private readonly ledger: LedgerService,
    @InjectModel(Payout) private readonly payoutModel: typeof Payout,
  ) {}

  /**
   * Balance from the projection (Redis HGET, sub-ms) - never a SUM over
   * millions of ledger rows per page view. Falls back to the authoritative
   * SQL sum if the projection has no entry yet.
   */
  @ShopScoped('payouts.read')
  @Get('balance')
  async balance(@Param('shopId', ParseUUIDPipe) shopId: string) {
    const account = shopAccount(shopId);
    const projected = await this.redis.client.hget(BALANCES_KEY, account).catch(() => null);
    return projected !== null
      ? { available: Number(projected), source: 'projection' }
      : { available: await this.ledger.balance(account), source: 'ledger' };
  }

  @ShopScoped('payouts.read')
  @Get('payouts')
  payouts(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.payoutModel.findAll({ where: { shopId }, order: [['periodStart', 'DESC']], limit: 52 });
  }
}
