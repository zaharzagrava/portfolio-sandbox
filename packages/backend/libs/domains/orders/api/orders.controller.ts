import {
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { OrderCancellationService } from '../application/order-cancellation.service';

/** The buyer's order routes. Reads (`GET /orders`, `GET /orders/:id`) arrive with the reads story (US6). */
@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly cancellation: OrderCancellationService) {}

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
