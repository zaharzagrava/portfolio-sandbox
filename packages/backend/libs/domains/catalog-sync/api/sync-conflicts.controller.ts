import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  syncConflictListQuerySchema,
  type SyncConflict,
  type SyncConflictPage,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { SyncConflictService } from '../application/sync-conflict.service';
import { UuidParamPipe, ZodPipe } from './zod.pipe';

const listQuery = new ZodPipe(syncConflictListQuerySchema);

/** Review of offline sync conflicts: members read (`products.read`), writers dismiss (`products.write`). */
@ApiTags('offline-sync')
@Controller('shops/:shopId/sync/conflicts')
export class SyncConflictsController {
  constructor(private readonly conflicts: SyncConflictService) {}

  @ShopScoped('products.read')
  @Get()
  list(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Query(listQuery)
    query: ReturnType<(typeof syncConflictListQuerySchema)['parse']>,
  ): Promise<SyncConflictPage> {
    return this.conflicts.list(shopId, query);
  }

  @ShopScoped('products.write')
  @RateLimit('catalog-sync.conflict-write.shop')
  @HttpCode(200)
  @Post(':opId/dismiss')
  dismiss(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('opId', UuidParamPipe) opId: string,
    @User() user: UserRawDto,
  ): Promise<SyncConflict> {
    return this.conflicts.dismiss(shopId, opId, user.id);
  }
}
