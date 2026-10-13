import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  pickupListQuerySchema,
  pickupPointCreateSchema,
  pickupPointPatchSchema,
  pickupStockAdjustSchema,
  pickupStockSetSchema,
  type PickupListQuery,
  type PickupPoint,
  type PickupPointCreate,
  type PickupPointPage,
  type PickupPointPatch,
  type PickupStock,
  type PickupStockAdjust,
  type PickupStockAdjusted,
  type PickupStockPage,
  type PickupStockSet,
} from '@marketplace-sandbox/contracts';
import { ShopScoped } from '@app/domains/tenancy';
import { Idempotent } from '@app/infrastructure/idempotency';
import { PickupPointsService } from '../application/pickup-points.service';
import { PickupStockService } from '../application/pickup-stock.service';
import { PickupZodPipe } from './pickup-zod.pipe';

const createBody = new PickupZodPipe(pickupPointCreateSchema);
const patchBody = new PickupZodPipe(pickupPointPatchSchema);
const setBody = new PickupZodPipe(pickupStockSetSchema);
const adjustBody = new PickupZodPipe(pickupStockAdjustSchema);
const listQuery = new PickupZodPipe(pickupListQuerySchema);

/** Adjustments are retried by clients; a key lives 24 hours (S19 FR-013). */
const ADJUSTMENT_KEY_TTL_SECONDS = 24 * 3600;

/**
 * Seller API: points and local stock of one shop (S19 FR-001..FR-015). Writes need `products.write`, reads
 * `products.read`; the shop gate (`401`, `404`, `403`, `shop_suspended`) is S03's. One service call per method.
 */
@ApiTags('pickup')
@Controller('shops/:shopId/pickup-points')
export class PickupPointsController {
  constructor(
    private readonly points: PickupPointsService,
    private readonly stock: PickupStockService,
  ) {}

  @ShopScoped('products.write')
  @Post()
  @HttpCode(201)
  create(
    @Param('shopId') shopId: string,
    @Body(createBody) input: PickupPointCreate,
  ): Promise<PickupPoint> {
    return this.points.create(shopId.toLowerCase(), input);
  }

  @ShopScoped('products.read')
  @Get()
  list(
    @Param('shopId') shopId: string,
    @Query(listQuery) query: PickupListQuery,
  ): Promise<PickupPointPage> {
    return this.points.list(shopId.toLowerCase(), query);
  }

  @ShopScoped('products.write')
  @Patch(':pointId')
  update(
    @Param('shopId') shopId: string,
    @Param('pointId', ParseUUIDPipe) pointId: string,
    @Body(patchBody) patch: PickupPointPatch,
  ): Promise<PickupPoint> {
    return this.points.update(shopId.toLowerCase(), pointId, patch);
  }

  @ShopScoped('products.read')
  @Get(':pointId/stock')
  listStock(
    @Param('shopId') shopId: string,
    @Param('pointId', ParseUUIDPipe) pointId: string,
    @Query(listQuery) query: PickupListQuery,
  ): Promise<PickupStockPage> {
    return this.stock.list(shopId.toLowerCase(), pointId, query);
  }

  @ShopScoped('products.write')
  @Put(':pointId/stock/:productId')
  setStock(
    @Param('shopId') shopId: string,
    @Param('pointId', ParseUUIDPipe) pointId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body(setBody) input: PickupStockSet,
  ): Promise<PickupStock> {
    return this.stock.set(shopId.toLowerCase(), pointId, productId, input);
  }

  @ShopScoped('products.write')
  @Idempotent({ ttlSeconds: ADJUSTMENT_KEY_TTL_SECONDS })
  @Post(':pointId/stock/:productId/adjustments')
  @HttpCode(200)
  adjustStock(
    @Param('shopId') shopId: string,
    @Param('pointId', ParseUUIDPipe) pointId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body(adjustBody) input: PickupStockAdjust,
  ): Promise<PickupStockAdjusted> {
    return this.stock.adjust(
      shopId.toLowerCase(),
      pointId,
      productId,
      input.delta,
    );
  }
}
