import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';
import { v7 as uuidv7 } from 'uuid';
import { ShopScoped } from '@app/domains/tenancy';
import { API_VERSIONS } from '../domain/versioning';
import { WebhookEndpointsService } from '../application/webhook-endpoints.service';
import { WebhookDeliverer } from '../application/webhook-deliverer.service';
import { WebhookRouterProjector } from '../infra/webhook-router.projector';
import { WEBHOOK_EVENT_TYPES } from '../domain/webhook-events';
import type { WebhookEventType } from '../domain/webhook-events';

export class CreateEndpointDto {
  @ApiProperty()
  @IsUrl({ require_tld: false, require_protocol: true })
  url: string;
  @ApiProperty({ enum: WEBHOOK_EVENT_TYPES, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  events: WebhookEventType[];
  @ApiPropertyOptional({ enum: API_VERSIONS })
  @IsOptional()
  @IsIn(API_VERSIONS)
  apiVersion?: string;
}

export class UpdateEndpointDto {
  @ApiPropertyOptional() @IsOptional() @IsString() url?: string;
  @ApiPropertyOptional({ enum: WEBHOOK_EVENT_TYPES, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  events?: WebhookEventType[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
}

@ApiTags('developers')
@Controller('shops/:shopId/developers/webhooks')
export class WebhooksController {
  constructor(
    private readonly endpoints: WebhookEndpointsService,
    private readonly deliverer: WebhookDeliverer,
    private readonly router: WebhookRouterProjector,
  ) {}

  @ShopScoped('shop.manage')
  @Post()
  create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: CreateEndpointDto,
  ) {
    return this.endpoints.create(shopId, body);
  }

  @ShopScoped('shop.read')
  @Get()
  list(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.endpoints.list(shopId);
  }

  @ShopScoped('shop.manage')
  @Patch(':id')
  @HttpCode(204)
  update(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateEndpointDto,
  ) {
    return this.endpoints.update(shopId, id, body);
  }

  @ShopScoped('shop.manage')
  @Post(':id/rotate-secret')
  rotate(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.endpoints.rotateSecret(shopId, id);
  }

  @ShopScoped('shop.manage')
  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.endpoints.remove(shopId, id);
  }

  @ShopScoped('shop.read')
  @Get(':id/attempts')
  async attempts(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const endpoint = await this.endpoints.get(id);
    return endpoint?.shopId === shopId ? this.deliverer.attempts(id) : [];
  }

  @ShopScoped('shop.manage')
  @Post(':id/events/:eventId/replay')
  async replay(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('eventId') eventId: string,
  ) {
    return { outcome: await this.deliverer.replay(shopId, id, eventId) };
  }

  /** Sends a `webhook.ping` to every endpoint subscribed to it - "test this endpoint" button. */
  @ShopScoped('shop.manage')
  @Post('ping')
  async ping(@Param('shopId', ParseUUIDPipe) shopId: string) {
    const queued = await this.router.fanOut({
      shopId,
      type: 'webhook.ping',
      eventId: `evt_${uuidv7().replace(/-/g, '')}`,
      created: new Date().toISOString(),
      resource: 'product',
      object: { object: 'ping' },
    });
    return { queued };
  }
}
