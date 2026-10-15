import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ShopScoped } from '@app/domains/tenancy';
import { WEBHOOK_EVENT_CATALOGUE } from '../domain/webhook-events';

/** The event types a shop can subscribe to, in their fixed order (FR-010, FR-020). */
@ApiTags('developers')
@Controller('shops/:shopId/developers/webhook-event-types')
export class WebhookEventTypesController {
  @ShopScoped('webhooks.manage')
  @Get()
  list() {
    return { items: WEBHOOK_EVENT_CATALOGUE.map((entry) => ({ ...entry })) };
  }
}
