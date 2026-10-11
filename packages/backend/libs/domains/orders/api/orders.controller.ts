import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { OrderCancellationService } from '../application/order-cancellation.service';
import { OrderQueryService } from '../application/order-query.service';
import { ListOrdersQueryDto } from './orders.dto';

/** The buyer's order routes. */
@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly cancellation: OrderCancellationService,
    private readonly queries: OrderQueryService,
  ) {}

  @Firewall()
  @Get()
  list(@User() user: AuthenticatedUser, @Query() query: ListOrdersQueryDto) {
    return this.queries.getOrdersForUser(
      user.id,
      query.limit,
      query.cursor ?? null,
    );
  }

  @Firewall()
  @Get(':orderId')
  get(
    @User() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.queries.getOrderForUser(orderId, user.id);
  }

  @Firewall({ sensitive: true })
  @RateLimit('orders.cancel.user')
  @HttpCode(200)
  @Post(':orderId/cancel')
  cancel(
    @User() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.cancellation.cancel(orderId, user.id);
  }
}
