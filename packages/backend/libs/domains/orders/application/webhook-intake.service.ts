import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { InboxService } from '@app/infrastructure/inbox';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import {
  InvalidPayloadError,
  InvalidSignatureError,
  PayloadTooLargeError,
} from '../domain/order-errors';
import { webhookEventCounter } from '../domain/order-metrics';
import { verifyStripeSignature } from '../domain/webhook-signature';
import type { ProcessWebhookPayload } from './order.job-types';

import './order.job-types';

const SOURCE = 'stripe';

const objectSchema = z
  .object({
    id: z.string().optional(),
    amount: z.number().int().nonnegative().optional(),
    amount_received: z.number().int().nonnegative().optional(),
    amount_refunded: z.number().int().nonnegative().optional(),
    currency: z.string().optional(),
    payment_intent: z.union([z.string(), z.null()]).optional(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

/** Only what the intake needs of the provider's event; anything else in the body is ignored and never stored. */
const eventSchema = z
  .object({
    id: z.string().min(1).max(255),
    type: z.string().min(1).max(255),
    data: z.object({ object: objectSchema.optional() }).optional(),
  })
  .passthrough();

export type WebhookAck = { received: true; duplicate?: true };

/**
 * The webhook intake (S10 FR-033, FR-034): verify the signature over the raw body, read the few fields processing needs,
 * store the event and queue its processing in one transaction, and answer `200` before anything is applied. The raw
 * body, the signature and the secrets are never stored or logged; a duplicate is acknowledged and queues nothing.
 */
@Injectable()
export class WebhookIntakeService {
  constructor(
    private readonly inbox: InboxService,
    private readonly jobs: JobsService,
    private readonly runner: TransactionRunner,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async receive(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<WebhookAck> {
    if (
      rawBody &&
      rawBody.length > this.config.get('orders_webhook_body_limit_bytes')
    )
      throw new PayloadTooLargeError();
    const secrets = [
      this.config.get('stripe_webhook_secret'),
      this.config.get('stripe_webhook_secret_previous'),
    ].filter((s): s is string => !!s);
    try {
      if (!rawBody) throw new InvalidSignatureError();
      verifyStripeSignature(rawBody, signature, secrets, this.clock.now());
    } catch (error) {
      webhookEventCounter.add(1, { result: 'invalid_signature' });
      throw error;
    }

    const event = this.parse(rawBody as Buffer);
    const payload = this.payloadOf(event);

    const duplicate = await this.runner.run(async () => {
      const claim = await this.inbox.claim(SOURCE, event.id);
      if (claim.outcome !== 'CLAIMED') return true;
      await this.jobs.enqueue('orders.process-webhook', payload, {
        idempotencyKey: `stripe:${event.id}:${claim.attempts}`,
        maxAttempts: this.config.get('orders_webhook_max_attempts'),
      });
      return false;
    });
    webhookEventCounter.add(1, {
      result: duplicate ? 'duplicate' : 'received',
    });
    return duplicate ? { received: true, duplicate: true } : { received: true };
  }

  private parse(rawBody: Buffer): z.infer<typeof eventSchema> {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidPayloadError();
    }
    const parsed = eventSchema.safeParse(json);
    if (!parsed.success) throw new InvalidPayloadError();
    return parsed.data;
  }

  /** The provider's intent id is the payment reference; a refund names its intent. */
  private payloadOf(event: z.infer<typeof eventSchema>): ProcessWebhookPayload {
    const object = event.data?.object;
    const isCharge = event.type.startsWith('charge.');
    const orderId = object?.metadata?.orderId;
    return {
      eventId: event.id,
      type: event.type,
      orderId: typeof orderId === 'string' ? orderId.slice(0, 64) : null,
      paymentRef: (isCharge ? object?.payment_intent : object?.id) ?? null,
      amountMinor:
        (event.type === 'payment_intent.succeeded'
          ? object?.amount_received
          : object?.amount) ?? null,
      currency: object?.currency ?? null,
      refundedMinor: object?.amount_refunded ?? null,
    };
  }
}
