import { Controller, Get, Param, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, UserUtilsService } from '@app/domains/identity';
import type { RequestWithUser } from '@app/domains/identity';
import { PaymentQueryService } from './payment-query.service';

@ApiTags('payment')
@Controller('payment')
export class PaymentQueryController {
  constructor(
    private readonly paymentQueryService: PaymentQueryService,
    private readonly userUtilsService: UserUtilsService,
  ) {}

  /**
   * Lets a client (and the k6 payment flow) resolve the async command it
   * fired at the edge - it only knows the idempotency key, never the
   * payment id. 404 until payment-processor has picked the event up.
   */
  @Firewall()
  @Get('/by-key/:idempotencyKey')
  async getByIdempotencyKey(
    @Param('idempotencyKey') idempotencyKey: string,
    @Request() request: RequestWithUser,
  ) {
    const viewerUser = this.userUtilsService.getUser(request);
    return await this.paymentQueryService.getPaymentByIdempotencyKey({
      idempotencyKey,
      viewerUser,
    });
  }

  @Firewall()
  @Get('/:id')
  async get(@Param('id') id: string, @Request() request: RequestWithUser) {
    const viewerUser = this.userUtilsService.getUser(request);
    return await this.paymentQueryService.getPayment({ id, viewerUser });
  }

  @Firewall()
  @Get('/')
  async list(@Request() request: RequestWithUser) {
    const viewerUser = this.userUtilsService.getUser(request);
    return await this.paymentQueryService.listPayments({ viewerUser });
  }
}
