import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { PayoutCancelService } from '../application/payout-cancel.service';
import { PayoutDestinationService } from '../application/payout-destination.service';
import { PayoutQueryService } from '../application/payout-query.service';
import { PayoutReserveService } from '../application/payout-reserve.service';
import { AdminOnly } from './admin-only.decorator';
import {
  AdminPayoutQueryDto,
  CancelPayoutDto,
  PayoutPageQueryDto,
  SetDestinationDto,
  SetReserveDto,
} from './payout.dto';

/** The finance operator API for payouts (S15 contracts/http.md): platform `admin` only, thin, writes idempotent. */
@ApiTags('finance')
@Controller('finance')
export class PayoutsAdminController {
  constructor(
    private readonly queries: PayoutQueryService,
    private readonly destinations: PayoutDestinationService,
    private readonly reserves: PayoutReserveService,
    private readonly cancellation: PayoutCancelService,
  ) {}

  @AdminOnly()
  @RateLimit('finance.admin.read')
  @Get('payouts')
  list(@Query() query: AdminPayoutQueryDto) {
    return this.queries.listAll(query);
  }

  @AdminOnly()
  @RateLimit('finance.admin.read')
  @Get('payouts/runs')
  runs(@Query() query: PayoutPageQueryDto) {
    return this.queries.listRuns(query);
  }

  @AdminOnly({ sensitive: true })
  @RateLimit('finance.admin.write')
  @Idempotent()
  @HttpCode(200)
  @Put('shops/:shopId/payout-destination')
  setDestination(
    @User() user: AuthenticatedUser,
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: SetDestinationDto,
  ) {
    return this.destinations.set(
      shopId.toLowerCase(),
      body.providerAccountId,
      user.id,
    );
  }

  @AdminOnly({ sensitive: true })
  @RateLimit('finance.admin.write')
  @Idempotent()
  @HttpCode(200)
  @Put('shops/:shopId/payout-reserve')
  setReserve(
    @User() user: AuthenticatedUser,
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: SetReserveDto,
  ) {
    return this.reserves.set(
      shopId.toLowerCase(),
      body.reserveBps,
      body.reason,
      user.id,
    );
  }

  @AdminOnly({ sensitive: true })
  @RateLimit('finance.admin.write')
  @Idempotent()
  @HttpCode(200)
  @Post('payouts/:payoutId/cancel')
  cancel(
    @User() user: AuthenticatedUser,
    @Param('payoutId', ParseUUIDPipe) payoutId: string,
    @Body() body: CancelPayoutDto,
  ) {
    return this.cancellation.cancel(
      payoutId.toLowerCase(),
      user.id,
      body.reason,
    );
  }
}
