import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/sequelize';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ShopScoped } from '@app/domains/tenancy';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import FlashSale from '../infra/models/flash-sale.model';
import { ProductModel as Product } from '@app/domains/catalog';
import { CheckoutService } from '../application/checkout.service';
import { OrderService } from '../application/order.service';
import { CartIdentity } from './cart-identity';
import { CreateFlashSaleDto } from './orders.dto';

import '../application/order.job-types';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

@ApiTags('orders')
@Controller()
export class OrdersController {
  constructor(
    private readonly checkoutService: CheckoutService,
    private readonly orders: OrderService,
    private readonly jobs: JobsService,
    @InjectModel(FlashSale) private readonly flashSaleModel: typeof FlashSale,
    @InjectModel(Product) private readonly productModel: typeof Product,
  ) {}

  /** POST /api/checkout with `Idempotency-Key` - retries (double clicks, flaky networks) return the same order. */
  @Firewall()
  @RateLimit('checkout.create')
  @Post('checkout')
  async checkout(
    @User() user: UserRawDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey))
      throw new BadRequestException(
        'Idempotency-Key header (8-128 chars) is required',
      );
    return this.checkoutService.checkout(
      user.id,
      CartIdentity.userCartId(user.id),
      idempotencyKey,
    );
  }

  @Firewall()
  @Get('orders')
  history(@User() user: UserRawDto, @Query('before') before?: string) {
    return this.checkoutService.history(user.id, before);
  }

  @Firewall()
  @Get('orders/:orderId')
  get(
    @User() user: UserRawDto,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.orders.get(orderId, user.id);
  }

  @Firewall()
  @HttpCode(200)
  @Post('orders/:orderId/cancel')
  async cancel(
    @User() user: UserRawDto,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    await this.orders.get(orderId, user.id); // ownership check (404 for other users' orders)
    return { cancelled: await this.orders.cancel(orderId, 'user_cancelled') };
  }

  /** A shop schedules a drop; jobs move units into Redis just before start and back after the end. */
  @ShopScoped('products.write')
  @Post('shops/:shopId/flash-sales')
  async createFlashSale(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: CreateFlashSaleDto,
  ) {
    const product = await this.productModel.findOne({
      where: { id: body.productId, shopId },
      attributes: ['id'],
    });
    if (!product)
      throw new BadRequestException('Product not found in this shop');
    if (Date.parse(body.endsAt) <= Date.parse(body.startsAt))
      throw new BadRequestException('endsAt must be after startsAt');

    const sale = await this.flashSaleModel.create({
      ...body,
      shopId,
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
    });
    await this.jobs.enqueue(
      'flash-sale.start',
      { saleId: sale.id },
      {
        runAt: new Date(Date.parse(body.startsAt) - 60_000),
        idempotencyKey: `flash-start:${sale.id}`,
        shopId,
      },
    );
    await this.jobs.enqueue(
      'flash-sale.end',
      { saleId: sale.id },
      {
        runAt: new Date(body.endsAt),
        idempotencyKey: `flash-end:${sale.id}`,
        shopId,
      },
    );
    return sale;
  }
}
