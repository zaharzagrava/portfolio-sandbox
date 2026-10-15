import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  integrationListQuerySchema,
  type ReconciliationPage,
  type ReconciliationReport,
} from '@marketplace-sandbox/contracts';
import { ShopScoped } from '@app/domains/tenancy';
import { ReconcileService } from '../application/reconcile.service';
import { UuidParamPipe, ZodPipe } from './zod.pipe';

const listQuery = new ZodPipe(integrationListQuerySchema);

/**
 * Reconciliation reports and the on-demand run (contracts/http-api.md). Permission `integrations.manage`, guard order
 * 401 -> 404 -> 403 -> status gate; the integration is looked up with the shop in the predicate. The one-per-hour limit
 * (`catalog-sync.reconcile-now.integration`) is charged by the service after the state check, so a refused `409` does
 * not use up the hour.
 */
@ApiTags('integrations')
@Controller('shops/:shopId/integrations/:integrationId')
export class ReconcileController {
  constructor(private readonly reconciliations: ReconcileService) {}

  @ShopScoped('integrations.manage')
  @Get('reconciliations')
  list(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
    @Query(listQuery)
    query: ReturnType<(typeof integrationListQuerySchema)['parse']>,
  ): Promise<ReconciliationPage> {
    return this.reconciliations.list(shopId, integrationId, query);
  }

  @ShopScoped('integrations.manage')
  @Get('reconciliations/:runId')
  get(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
    @Param('runId', UuidParamPipe) runId: string,
  ): Promise<ReconciliationReport> {
    return this.reconciliations.get(shopId, integrationId, runId);
  }

  @ShopScoped('integrations.manage')
  @HttpCode(202)
  @Post('reconcile')
  reconcile(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
  ): Promise<{ enqueued: boolean }> {
    return this.reconciliations.requestRun(shopId, integrationId);
  }
}
