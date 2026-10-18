import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { VoucherPage } from '@marketplace-sandbox/contracts';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { VoucherService } from '../application/voucher.service';
import { ListVouchersQueryDto } from './orders.dto';

/**
 * The buyer's booking vouchers (J03 G-44): own vouchers only, newest first. Declared before `OrdersController` in the
 * module, so `/orders/vouchers` never reaches `/orders/:orderId`.
 */
@ApiTags('orders')
@Controller('orders/vouchers')
export class VouchersController {
  constructor(private readonly vouchers: VoucherService) {}

  @Firewall()
  @Get()
  list(
    @User() user: AuthenticatedUser,
    @Query() query: ListVouchersQueryDto,
  ): Promise<VoucherPage> {
    return this.vouchers.listForUser(user.id, {
      launchEventId: query.launchEventId,
      limit: query.limit,
      cursor: query.cursor,
    });
  }
}
