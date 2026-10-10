import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall } from '@app/domains/identity';
import { ShopQueryService } from '../application/shop-query.service';
import { Domain_InvalidQueryError } from '../domain/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 100;

/**
 * Batch shop reads for the BFF's DataLoaders (constitution IX.7 R2): N shop lookups → one call. Public, non-sensitive
 * fields only; results in request order with nulls. Sandbox, suspended, closing and deleted shops read as `null`.
 */
@ApiTags('batch')
@Controller('batch')
export class ShopBatchReadController {
  constructor(private readonly shops: ShopQueryService) {}

  @Firewall({ anonymous: true })
  @Header('Cache-Control', 'public, max-age=30')
  @Get('shops')
  async list(@Query('ids') raw: string | undefined) {
    const ids = (raw ?? '').split(',');
    if (
      ids.length === 0 ||
      ids.length > MAX_IDS ||
      ids.some((id) => !UUID.test(id))
    )
      throw new Domain_InvalidQueryError('ids', 'invalid_ids');
    const found = await this.shops.getShopsByIds(
      ids.map((id) => id.toLowerCase()),
    );
    return ids.map((id) => {
      const shop = found.get(id.toLowerCase());
      return shop && shop.status === 'ACTIVE' && !shop.isSandbox
        ? { id: shop.id, name: shop.name, slug: shop.slug }
        : null;
    });
  }
}
