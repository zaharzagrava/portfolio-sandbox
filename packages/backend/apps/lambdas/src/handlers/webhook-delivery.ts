import { WebhooksLambdaModule } from '@app/domains/developer-platform';
import {
  defineSqsHandler,
  functionInfo,
  manifestEntry,
  metric,
  TransientError,
} from '@app/infrastructure/serverless';
import { nestContext } from '@app/infrastructure/serverless/context';

/**
 * SD-30 delivery as a Lambda on the FIFO queue (batch <= 10, ReportBatchItemFailures). The Nest context is cached per
 * container and comes from the domain's hosting module alone (S43 D-8, L-018). The delivery service itself claims each
 * attempt atomically and skips a delivery that is already `delivered`, so a message processed twice sends once (AS-44);
 * no extra idempotency table is needed here. A record that must be redelivered rejects with a `TransientError` and is
 * reported as failed; the queue's redrive policy moves it to the dead-letter queue after five receives (AS-45, AS-46).
 * Logs carry the message id and the receive count only: never a body, a URL or a secret.
 */
export const handler = defineSqsHandler({
  function: functionInfo('webhook-delivery'),
  init: async () =>
    WebhooksLambdaModule.host(
      await nestContext(WebhooksLambdaModule, {
        dbPoolMax: manifestEntry('webhook-delivery').dbPoolMax,
      }),
    ),
  handle: async (message, host, record) => {
    const started = Date.now();
    let outcome = 'redeliver';
    try {
      outcome = await host.handleRecord(record.body, message.receiveCount);
    } catch (error) {
      // an attempt that failed inside the ordered lane is a retry, not a fault
      if ((error as Error).name === 'WebhookRedeliverError')
        throw new TransientError('webhook delivery must be redelivered', {
          cause: error,
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
  },
});
