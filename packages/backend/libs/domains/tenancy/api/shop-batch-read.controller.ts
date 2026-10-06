import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { Firewall } from '@app/domains/identity';
import { parseIdList } from '@app/infrastructure/platform/parse-id-list';

/**
 * Batch shop reads for the BFF's DataLoaders (constitution IX.7 R2): N shop lookups → one call.
 * Public, non-sensitive fields only; results in request order with nulls.
 */
@ApiTags('batch')
@Controller('batch')
export class ShopBatchReadController {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  @Firewall({ anonymous: true, skipThrottle: true })
  @Header('Cache-Control', 'public, max-age=30')
  @Get('shops')
  async shops(@Query('ids') raw: string) {
    const ids = parseIdList(raw);
    const rows = await this.sequelize.query<{ id: string; name: string; slug: string }>(`SELECT id, name, slug FROM "Shop" WHERE id IN (:ids) AND "sandboxOf" IS NULL`, {
      type: QueryTypes.SELECT,
      replacements: { ids },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id) ?? null);
  }
}
