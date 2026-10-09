import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { Firewall } from '@app/domains/identity';
import { parseIdList } from '@app/infrastructure/platform/parse-id-list';

/**
 * Batch product reads for the BFF's DataLoaders (constitution IX.7 R2): 20 products in a GraphQL list →
 * one call. Public, non-sensitive fields only; results in request order with nulls.
 */
@ApiTags('batch')
@Controller('batch')
export class ProductBatchReadController {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  @Firewall({ anonymous: true, skipThrottle: true })
  @Header('Cache-Control', 'public, max-age=10')
  @Get('products')
  async products(@Query('ids') raw: string) {
    const ids = parseIdList(raw);
    const rows = await this.sequelize.query<{
      id: string;
      title: string;
      price: string;
      quantity: number;
      category: string;
      shopId: string | null;
      rating: number;
    }>(
      `SELECT id, title, price, quantity, category, "shopId", rating FROM "Product" WHERE id IN (:ids)`,
      { type: QueryTypes.SELECT, replacements: { ids } },
    );
    const byId = new Map(
      rows.map((r) => [r.id, { ...r, price: Number(r.price) }]),
    );
    return ids.map((id) => byId.get(id) ?? null);
  }
}
