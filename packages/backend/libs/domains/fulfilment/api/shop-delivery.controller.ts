import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  cancelDeliveryRequestSchema,
  deliveryStatusSchema,
  requestDeliveryRequestSchema,
  type CancelDeliveryRequest,
  type DeliveryPage,
  type DeliveryShopView,
  type RequestDeliveryRequest,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { DeliveryActionsService } from '../application/delivery-actions.service';
import { DeliveryReadService } from '../application/delivery-read.service';
import { DeliveryRequestService } from '../application/delivery-request.service';
import { DeliveryZodPipe } from './delivery-zod.pipe';

const requestBody = new DeliveryZodPipe(requestDeliveryRequestSchema);
const cancelBody = new DeliveryZodPipe(cancelDeliveryRequestSchema);

const MAX_PAGE = 50;
const DEFAULT_PAGE = 20;
/** `?status&limit&cursor` and nothing else; `limit` is a plain decimal integer in 1..50. */
const listQuerySchema = z
  .object({
    status: deliveryStatusSchema.optional(),
    limit: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(MAX_PAGE))
      .default(DEFAULT_PAGE),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
const listQuery = new DeliveryZodPipe(listQuerySchema);
/** A named alias: decorator metadata would otherwise try to emit `z.output` as a runtime class. */
type ListQuery = z.output<typeof listQuerySchema>;

/**
 * The shop's side of a delivery (S20 contracts/delivery-api.md): request (idempotent, rate limited, fails closed), list,
 * detail and cancel. The shop gate (`401`, `404` for a non-member, `403` without the permission) is S03's, and the shop
 * id is in the predicate of every lookup, so another shop's delivery is a `404`. One service call per method.
 */
@ApiTags('delivery')
@Controller('shops/:shopId/deliveries')
export class ShopDeliveryController {
  constructor(
    private readonly requests: DeliveryRequestService,
    private readonly reads: DeliveryReadService,
    private readonly actions: DeliveryActionsService,
  ) {}

  @ShopScoped('orders.manage')
  @RateLimit('fulfilment.delivery-request')
  @Idempotent()
  @Post()
  @HttpCode(201)
  async request(
    @Param('shopId') shopId: string,
    @Body(requestBody) body: RequestDeliveryRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryShopView> {
    const id = shopId.toLowerCase();
    const view = await this.requests.request(id, body);
    res.setHeader('Location', `/api/shops/${id}/deliveries/${view.id}`);
    return view;
  }

  @ShopScoped('orders.read')
  @RateLimit('fulfilment.delivery-actions')
  @Get()
  list(
    @Param('shopId') shopId: string,
    @Query(listQuery) query: ListQuery,
  ): Promise<DeliveryPage> {
    return this.reads.listForShop(shopId.toLowerCase(), query);
  }

  @ShopScoped('orders.read')
  @RateLimit('fulfilment.delivery-actions')
  @Get(':id')
  detail(
    @Param('shopId') shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DeliveryShopView> {
    return this.reads.shopDetail(shopId.toLowerCase(), id);
  }

  @ShopScoped('orders.manage')
  @RateLimit('fulfilment.delivery-actions')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('shopId') shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(cancelBody) body: CancelDeliveryRequest,
    @User() user: UserRawDto,
  ): Promise<DeliveryShopView> {
    return this.actions.cancelByShop(
      shopId.toLowerCase(),
      id,
      user.id,
      body.reason,
    );
  }
}
