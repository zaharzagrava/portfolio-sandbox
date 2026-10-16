import { Controller, Delete, Get, HttpCode, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ShopScoped } from '@app/domains/tenancy';
import { DigitalService } from '../application/digital.service';
import { assetNotFound } from '../domain/errors';
import { UuidParamPipe } from './zod.pipes';

/** The link between a product and a file (S31 FR-039): writes need `products.write`, the read `products.read`. */
@ApiTags('digital')
@Controller()
export class DigitalController {
  constructor(private readonly digital: DigitalService) {}

  @ShopScoped('products.write')
  @HttpCode(204)
  @Put('shops/:shopId/products/:productId/digital-asset/:assetId')
  async link(
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Param('assetId', new UuidParamPipe(assetNotFound)) assetId: string,
  ) {
    await this.digital.link(shopId, productId, assetId);
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/products/:productId/digital-asset')
  get(@Param('shopId') shopId: string, @Param('productId') productId: string) {
    return this.digital.get(shopId, productId);
  }

  @ShopScoped('products.write')
  @HttpCode(204)
  @Delete('shops/:shopId/products/:productId/digital-asset')
  async unlink(
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
  ) {
    await this.digital.unlink(shopId, productId);
  }
}
