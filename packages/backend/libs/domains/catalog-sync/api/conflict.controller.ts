import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  conflictListQuerySchema,
  type ConflictPage,
  type StockConflict,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ConflictService } from '../application/conflict.service';
import { UuidParamPipe, ZodPipe } from './zod.pipe';

const listQuery = new ZodPipe(conflictListQuerySchema);

/** Stock-conflict queue (contracts/http-api.md): permission `integrations.manage`, guard order 401 -> 404 -> 403. */
@ApiTags('integrations')
@Controller('shops/:shopId/integrations/:integrationId/conflicts')
export class ConflictController {
  constructor(private readonly conflicts: ConflictService) {}

  @ShopScoped('integrations.manage')
  @Get()
  list(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
    @Query(listQuery)
    query: ReturnType<(typeof conflictListQuerySchema)['parse']>,
  ): Promise<ConflictPage> {
    return this.conflicts.list(shopId, integrationId, query);
  }

  @ShopScoped('integrations.manage')
  @RateLimit('catalog-sync.integration-write.shop')
  @HttpCode(200)
  @Post(':conflictId/dismiss')
  dismiss(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
    @Param('conflictId', UuidParamPipe) conflictId: string,
    @User() user: UserRawDto,
  ): Promise<StockConflict> {
    return this.conflicts.dismiss(shopId, integrationId, conflictId, user.id);
  }
}
