import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  quarantineListQuerySchema,
  type QuarantineItem,
  type QuarantinePage,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { QuarantineService } from '../application/quarantine.service';
import { UuidParamPipe, ZodPipe } from './zod.pipe';

const listQuery = new ZodPipe(quarantineListQuerySchema);

/** Quarantine review (contracts/http-api.md): permission `integrations.manage`, guard order 401 -> 404 -> 403. */
@ApiTags('integrations')
@Controller('shops/:shopId/integrations/:integrationId/quarantine')
export class QuarantineController {
  constructor(private readonly quarantine: QuarantineService) {}

  @ShopScoped('integrations.manage')
  @Get()
  list(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
    @Query(listQuery)
    query: ReturnType<(typeof quarantineListQuerySchema)['parse']>,
  ): Promise<QuarantinePage> {
    return this.quarantine.list(shopId, integrationId, query);
  }

  @ShopScoped('integrations.manage')
  @RateLimit('catalog-sync.integration-write.shop')
  @HttpCode(200)
  @Post(':quarantineId/retry')
  retry(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
    @Param('quarantineId', UuidParamPipe) quarantineId: string,
  ): Promise<{ outcome: 'resolved' | 'still_invalid'; item: QuarantineItem }> {
    return this.quarantine.retry(shopId, integrationId, quarantineId);
  }

  @ShopScoped('integrations.manage')
  @RateLimit('catalog-sync.integration-write.shop')
  @HttpCode(200)
  @Post(':quarantineId/dismiss')
  dismiss(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
    @Param('quarantineId', UuidParamPipe) quarantineId: string,
    @User() user: UserRawDto,
  ): Promise<QuarantineItem> {
    return this.quarantine.dismiss(
      shopId,
      integrationId,
      quarantineId,
      user.id,
    );
  }
}
