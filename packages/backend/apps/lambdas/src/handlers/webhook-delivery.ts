import { WebhooksLambdaModule } from '@app/domains/developer-platform';
import { nestContext } from '../shared/nest-context';
import { processBatch, SqsBatchResponse, SqsEvent } from '../shared/sqs-batch';
import { log, metric } from '../shared/telemetry';

/**
 * SD-30 delivery as a Lambda on the FIFO queue (batch <= 10, ReportBatchItemFailures). The Nest context is cached per
 * container and comes from the domain's hosting module alone (S43 D-8, L-018). The delivery service itself claims each
 * attempt atomically and skips a delivery that is already `delivered`, so a message processed twice sends once (AS-44);
 * no extra idempotency table is needed here. A record that must be redelivered rejects and is reported as failed; the
 * queue's redrive policy moves it to the dead-letter queue after five receives (AS-45, AS-46). Logs carry the message id
 * and the receive count only: never a body, a URL or a secret.
 */
export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  const host = WebhooksLambdaModule.host(
    await nestContext(WebhooksLambdaModule),
  );
  return processBatch(event, async (record) => {
    const started = Date.now();
    const receives = Number(record.attributes.ApproximateReceiveCount);
    let outcome = 'redeliver';
    try {
      outcome = await host.handleRecord(record.body, receives);
    } catch (error) {
      // an attempt that failed inside the ordered lane is expected; anything else is a fault worth a line
      if ((error as Error).name !== 'WebhookRedeliverError')
        log('warn', 'webhook delivery record failed', {
          messageId: record.messageId,
          receives,
          error: (error as Error).name,
        });
      throw error;
    } finally {
      metric('Marketplace/Webhooks', 'Deliveries', 1, 'Count', { outcome });
      metric(
        'Marketplace/Webhooks',
        'DeliveryMs',
        Date.now() - started,
        'Milliseconds',
        { outcome },
      );
    }
  });
}
