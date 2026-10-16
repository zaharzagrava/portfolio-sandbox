import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
  DeliveryBuyerList,
  DeliveryBuyerView,
  DeliveryCourierView,
} from '@marketplace-sandbox/contracts';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { DeliveryActionsService } from '../application/delivery-actions.service';
import { DeliveryReadService } from '../application/delivery-read.service';
import { DispatchService } from '../application/dispatch.service';

/**
 * The courier's actions on a delivery (S20 FR-020..FR-025): accept, decline, picked-up, delivered; and the two role
 * reads (FR-036..FR-039): `GET /deliveries/:id` for the buyer or the assigned / offered courier, and
 * `GET /orders/:orderId/deliveries` for the buyer. The caller is the session's user, never a path or body value; a
 * delivery that is not theirs is a 404. One service call per method.
 */
@ApiTags('delivery')
@Controller()
export class DeliveryController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly actions: DeliveryActionsService,
    private readonly reads: DeliveryReadService,
  ) {}

  @Firewall()
  @RateLimit('fulfilment.delivery-actions')
  @Get('deliveries/:id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: UserRawDto,
  ): Promise<DeliveryBuyerView | DeliveryCourierView> {
    return this.reads.forCaller(id, user.id);
  }

  @Firewall()
  @RateLimit('fulfilment.delivery-actions')
  @Get('orders/:orderId/deliveries')
  forOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @User() user: UserRawDto,
  ): Promise<DeliveryBuyerList> {
    return this.reads.forBuyerByOrder(orderId, user.id);
  }

  @Firewall()
  @RateLimit('fulfilment.delivery-actions')
  @Post('deliveries/:id/accept')
  @HttpCode(200)
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: UserRawDto,
  ): Promise<DeliveryCourierView> {
    return this.dispatch.accept(id, user.id);
  }

  @Firewall()
  @RateLimit('fulfilment.delivery-actions')
  @Post('deliveries/:id/decline')
  @HttpCode(204)
  decline(
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    return this.dispatch.decline(id, user.id);
  }

  @Firewall()
  @RateLimit('fulfilment.delivery-actions')
  @Post('deliveries/:id/picked-up')
  @HttpCode(204)
  pickedUp(
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    return this.actions.pickUp(id, user.id);
  }

  @Firewall()
  @RateLimit('fulfilment.delivery-actions')
  @Post('deliveries/:id/delivered')
  @HttpCode(204)
  delivered(
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    return this.actions.deliver(id, user.id);
  }
}
