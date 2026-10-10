import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { RateLimitExempt } from '@app/infrastructure/rate-limit';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';
import { ApiConfigService } from '@app/common/config';
import { PaymentModel as Payment } from '@app/domains/payments';
import { OrderService } from '../application/order.service';

/**
 * Stripe → us (lesson 04/03 §5 consuming webhooks):
 *  1. verify the signature over the RAW body (rejects forgeries + old timestamps),
 *  2. inbox: (provider, event.id) inserted ON CONFLICT DO NOTHING - Stripe
 *     retries and duplicate deliveries are processed once,
 *  3. out-of-order safe: transitions are guarded by current status, so a late
 *     `payment_failed` after `succeeded` is a no-op,
 *  4. acknowledge fast (200) - heavy work belongs in async consumers.
 * Redundant with the Kafka payments.responses path on purpose: whichever
 * arrives first marks the order paid; the other is a no-op.
 */
@RateLimitExempt('payment provider webhook, signature-verified')
@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly config: ApiConfigService,
    private readonly orders: OrderService,
    @InjectModel(Payment) private readonly paymentModel: typeof Payment,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  @Post('stripe')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    const secret = this.config.get('stripe_webhook_secret');
    if (!secret || !req.rawBody || !signature)
      throw new BadRequestException('Unsigned webhook');
    let event: ReturnType<StripeService['constructEvent']>;
    try {
      event = this.stripe.constructEvent(req.rawBody, signature, secret);
    } catch {
      throw new BadRequestException('Invalid webhook signature');
    }

    const inserted = await this.sequelize.query(
      `INSERT INTO "ProcessedWebhookEvent" (provider, "eventId") VALUES ('stripe', :id) ON CONFLICT DO NOTHING RETURNING "eventId"`,
      { type: QueryTypes.SELECT, replacements: { id: event.id } },
    );
    if (inserted.length === 0) return { received: true, duplicate: true };

    const intent = event.data.object as {
      id: string;
      metadata?: Record<string, string>;
    };
    const key = intent.metadata?.idempotencyKey;
    const payment = key
      ? await this.paymentModel.findOne({
          where: { idempotencyKey: key },
          attributes: ['id', 'bisOrderId'],
        })
      : null;
    if (!payment) {
      this.logger.warn(
        `stripe ${event.type} ${event.id}: no payment for key ${key}`,
      );
      return { received: true };
    }

    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.orders
          .markPaid(payment.bisOrderId, payment.id)
          .catch((e) => this.logger.warn(`markPaid: ${e.message}`));
        break;
      case 'payment_intent.payment_failed':
        await this.orders
          .cancel(payment.bisOrderId, 'payment_failed')
          .catch((e) => this.logger.warn(`cancel: ${e.message}`));
        break;
      default:
        break;
    }
    return { received: true };
  }
}
