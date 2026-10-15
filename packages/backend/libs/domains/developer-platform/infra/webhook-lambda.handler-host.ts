import { INestApplicationContext, Injectable } from '@nestjs/common';
import { WebhookDeliveryService } from '../application/webhook-delivery.service';
import { recordDeadLetter } from '../application/webhook-metrics';
import { DELIVERY_MAX_RECEIVES } from '../domain/webhook-events';

/**
 * What the Lambda handler of `apps/lambdas` calls for one SQS record (S43 plan, D-8): the handler imports only
 * `WebhooksLambdaModule`, asks it for this host and keeps the batch plumbing (partial-batch response, metrics) in the
 * app. A record that must be redelivered rejects (a message that is not a delivery, a store that is down, an attempt
 * that failed inside the ordered lane), so the app reports exactly that record as failed; the queue's redrive policy
 * moves it to the dead-letter queue after five receives.
 */
@Injectable()
export class WebhookLambdaHandlerHost {
  constructor(private readonly delivery: WebhookDeliveryService) {}

  /** Handles one record body; resolves the outcome label for metrics, rejects when the message must be redelivered. */
  async handleRecord(body: string, receiveCount: number): Promise<string> {
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        raw = undefined;
      }
      return await this.delivery.handle(
        WebhookDeliveryService.parse(raw),
        receiveCount,
      );
    } catch (error) {
      // The receive that reaches the redrive limit is the last: the queue moves the message to the dead-letter queue.
      if (receiveCount >= DELIVERY_MAX_RECEIVES) recordDeadLetter('delivery');
      throw error;
    }
  }

  static resolve(context: INestApplicationContext): WebhookLambdaHandlerHost {
    return context.get(WebhookLambdaHandlerHost);
  }
}
