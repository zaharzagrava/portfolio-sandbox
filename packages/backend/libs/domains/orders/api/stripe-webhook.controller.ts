import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { WebhookIntakeService } from '../application/webhook-intake.service';

/**
 * Stripe → us (S10 US4): no session, authenticated by the signature over the raw body. The route verifies, stores and
 * queues, then answers `200` at once; applying the event is a job. Its address-keyed limit (300 a minute) counts failed
 * signatures too, so forged traffic meets `429`.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class StripeWebhookController {
  constructor(private readonly intake: WebhookIntakeService) {}

  @Post('stripe')
  @HttpCode(200)
  @RateLimit('orders.webhook.ip')
  handle(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.intake.receive(req.rawBody, signature);
  }
}
