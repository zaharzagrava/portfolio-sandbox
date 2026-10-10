import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/sequelize';
import { ShopScoped } from '@app/domains/tenancy';
import { ProductQueryService } from '@app/domains/catalog';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import FlashSale from '../infra/models/flash-sale.model';
import { CreateFlashSaleDto } from './orders.dto';

import '../application/order.job-types';

/** Legacy flash-sale scheduling, served until S11 replaces flash sales (research D-9). Not part of the S10 contract. */
@ApiTags('orders')
@Controller()
export class FlashSaleController {
  constructor(
    private readonly jobs: JobsService,
    private readonly products: ProductQueryService,
    @InjectModel(FlashSale) private readonly flashSaleModel: typeof FlashSale,
  ) {}

  /** A shop schedules a drop; jobs move units into Redis just before start and back after the end. */
  @ShopScoped('products.write')
  @Post('shops/:shopId/flash-sales')
  async createFlashSale(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: CreateFlashSaleDto,
  ) {
    const owned = await this.products.getProductsByIds([body.productId], {
      shopId,
    });
    if (!owned.has(body.productId))
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
