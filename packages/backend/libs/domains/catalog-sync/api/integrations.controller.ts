import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  integrationInstallRequestSchema,
  integrationListQuerySchema,
  integrationSyncRequestSchema,
  wooConnectRequestSchema,
  type Integration,
  type IntegrationInstallResponse,
  type IntegrationPage,
  type IntegrationSyncRequest,
  type WooConnectRequest,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ConnectService } from '../application/connect.service';
import { IntegrationAdminService } from '../application/integration-admin.service';
import { OAuthService } from '../application/oauth.service';
import { UuidParamPipe, ZodPipe } from './zod.pipe';

const installBody = new ZodPipe(integrationInstallRequestSchema);
const wooBody = new ZodPipe(wooConnectRequestSchema);
const syncBody = new ZodPipe(integrationSyncRequestSchema);
const listQuery = new ZodPipe(integrationListQuerySchema);

/**
 * Shop-scoped integration routes (contracts/http-api.md). Permission `integrations.manage` (OWNER, ADMIN), never
 * `shop.manage` (A15); writes share the `catalog-sync.integration-write.shop` policy. The anonymous OAuth callback is on
 * its own controller.
 */
@ApiTags('integrations')
@Controller('shops/:shopId/integrations')
export class IntegrationsController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly connect: ConnectService,
    private readonly admin: IntegrationAdminService,
  ) {}

  @ShopScoped('integrations.manage')
  @RateLimit('catalog-sync.integration-write.shop')
  @HttpCode(200)
  @Post('shopify/install')
  install(
    @Param('shopId', UuidParamPipe) shopId: string,
    @User() user: UserRawDto,
    @Body(installBody) body: { shopDomain: string },
  ): Promise<IntegrationInstallResponse> {
    return this.oauth.startInstall(shopId, user.id, body.shopDomain);
  }

  @ShopScoped('integrations.manage')
  @Get()
  list(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Query(listQuery)
    query: ReturnType<(typeof integrationListQuerySchema)['parse']>,
  ): Promise<IntegrationPage> {
    return this.admin.list(shopId, query);
  }

  @ShopScoped('integrations.manage')
  @Get(':integrationId')
  get(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
  ): Promise<Integration> {
    return this.admin.get(shopId, integrationId);
  }

  @ShopScoped('integrations.manage')
  @RateLimit('catalog-sync.integration-write.shop')
  @HttpCode(200)
  @Post(':integrationId/pause')
  pause(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
    @User() user: UserRawDto,
  ): Promise<Integration> {
    return this.admin.pause(shopId, integrationId, user.id);
  }

  @ShopScoped('integrations.manage')
  @RateLimit('catalog-sync.integration-write.shop')
  @HttpCode(200)
  @Post(':integrationId/resume')
  resume(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
    @User() user: UserRawDto,
  ): Promise<Integration> {
    return this.admin.resume(shopId, integrationId, user.id);
  }

  @ShopScoped('integrations.manage')
  @RateLimit('catalog-sync.integration-write.shop')
  @HttpCode(204)
  @Delete(':integrationId')
  async disconnect(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    await this.admin.disconnect(shopId, integrationId, user.id);
  }

  /** The 1/min (backfill 1/h) limits are charged by the service once a message is about to be queued. */
  @ShopScoped('integrations.manage')
  @HttpCode(202)
  @Post(':integrationId/sync')
  sync(
    @Param('shopId', UuidParamPipe) shopId: string,
    @Param('integrationId', UuidParamPipe) integrationId: string,
    @Body(syncBody) body: IntegrationSyncRequest,
  ): Promise<{ enqueued: boolean; reason?: 'breaker_open' }> {
    return this.admin.syncNow(shopId, integrationId, body);
  }

  /** `201` for a new integration, `200` with the same id for a repeat connect (L-010). */
  @ShopScoped('integrations.manage')
  @RateLimit('catalog-sync.integration-write.shop')
  @Post()
  async connectWoo(
    @Param('shopId', UuidParamPipe) shopId: string,
    @User() user: UserRawDto,
    @Body(wooBody) body: WooConnectRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Integration> {
    const { integration, created } = await this.connect.connectWoo(
      shopId,
      user.id,
      body,
    );
    res.status(created ? 201 : 200);
    return integration;
  }
}
