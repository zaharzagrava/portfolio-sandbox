import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
  ProductMemberView,
  ProductPage,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ProductCommandService } from '../application/product-command.service';
import { ProductIdPipe } from './product-id.pipe';
import { TransitionBody } from './product.dto';

/**
 * Member routes of a shop's products (S05 `contracts/http.md`). Each method is: guard (member, permission, shop status)
 * -> one service call -> a view built by the domain mappers. Bodies are validated by the service with the contract
 * schemas, so HTTP and the exported commands refuse exactly the same input.
 */
@ApiTags('products')
@Controller('shops/:shopId/products')
export class ProductController {
  constructor(private readonly commands: ProductCommandService) {}

  @ShopScoped('products.write')
  @RateLimit('catalog.product-write.shop')
  @Post()
  create(
    @Param('shopId') shopId: string,
    @User() user: UserRawDto,
    @Body() body: unknown,
  ): Promise<ProductMemberView> {
    return this.commands.create(shopId, user.id, body);
  }

  @ShopScoped('products.read')
  @Get()
  list(
    @Param('shopId') shopId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ProductPage> {
    return this.commands.listByShop(shopId, query);
  }

  @ShopScoped('products.read')
  @Get(':productId')
  get(
    @Param('shopId') shopId: string,
    @Param('productId', ProductIdPipe) productId: string,
  ): Promise<ProductMemberView> {
    return this.commands.getForShop(shopId, productId);
  }

  @ShopScoped('products.write')
  @RateLimit('catalog.product-write.shop')
  @Patch(':productId')
  update(
    @Param('shopId') shopId: string,
    @Param('productId', ProductIdPipe) productId: string,
    @User() user: UserRawDto,
    @Body() body: unknown,
  ): Promise<ProductMemberView> {
    return this.commands.update(shopId, productId, body, user.id);
  }

  @ShopScoped('products.write')
  @RateLimit('catalog.product-write.shop')
  @HttpCode(200)
  @Post(':productId/archive')
  archive(
    @Param('shopId') shopId: string,
    @Param('productId', ProductIdPipe) productId: string,
    @User() user: UserRawDto,
    @Body() body: unknown,
  ): Promise<ProductMemberView> {
    return this.commands.archive(
      shopId,
      productId,
      TransitionBody.expectedVersion(body),
      user.id,
    );
  }

  @ShopScoped('products.write')
  @RateLimit('catalog.product-write.shop')
  @HttpCode(200)
  @Post(':productId/restore')
  restore(
    @Param('shopId') shopId: string,
    @Param('productId', ProductIdPipe) productId: string,
    @User() user: UserRawDto,
    @Body() body: unknown,
  ): Promise<ProductMemberView> {
    return this.commands.restore(
      shopId,
      productId,
      TransitionBody.expectedVersion(body),
      user.id,
    );
  }
}
