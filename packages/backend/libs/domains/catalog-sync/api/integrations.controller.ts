import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { IsIn, IsObject, IsString, Length } from 'class-validator';
import { Firewall } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  IntegrationSyncService,
  SYNC_QUEUE,
} from '../application/integration-sync.service';

export class ConnectDto {
  @ApiProperty({ enum: ['shopify', 'woocommerce', 'fake'] })
  @IsIn(['shopify', 'woocommerce', 'fake'])
  provider: 'shopify' | 'woocommerce' | 'fake';
  @ApiProperty({ example: 'my-store.myshopify.com' })
  @IsString()
  @Length(3, 200)
  externalShop: string;
  @ApiProperty({
    description:
      'OAuth access token, webhook secret, location id - sealed at rest',
  })
  @IsObject()
  credentials: Record<string, string>;
}

@ApiTags('integrations')
@Controller()
export class IntegrationsController {
  constructor(
    private readonly sync: IntegrationSyncService,
    private readonly queue: TaskQueue,
  ) {}

  @ShopScoped('shop.manage')
  @Post('shops/:shopId/integrations')
  connect(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: ConnectDto,
  ) {
    return this.sync.connect(
      shopId,
      body.provider,
      body.externalShop,
      body.credentials,
    );
  }

  /**
   * Provider webhook: verify HMAC over the RAW body, enqueue, answer 200
   * immediately (providers retry/disable slow endpoints). The worker then
   * fetches the CURRENT state - webhook payloads can arrive out of order.
   */
  @ApiExcludeEndpoint()
  @Firewall({ anonymous: true, skipThrottle: true })
  @Post('integrations/:integrationId/webhooks')
  @HttpCode(200)
  async webhook(
    @Param('integrationId', ParseUUIDPipe) integrationId: string,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (
      !(await this.sync.verifyWebhook(
        integrationId,
        raw,
        req.headers as Record<string, string | undefined>,
      ))
    )
      throw new UnauthorizedException();
    const externalId = String((req.body as { id?: unknown })?.id ?? '');
    if (externalId)
      await this.queue.enqueue(SYNC_QUEUE, {
        integrationId,
        kind: 'one',
        externalId,
      });
    return { received: true };
  }
}
