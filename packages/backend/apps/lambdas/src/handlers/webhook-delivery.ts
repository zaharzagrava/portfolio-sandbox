import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { DatabaseModule } from '@app/infrastructure/database/database.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { PlatformModule } from '@app/infrastructure/platform/platform.module';
import { WebhooksCoreModule, WebhookDeliverer } from '@app/domains/developer-platform';
import type { WebhookDelivery } from '@app/domains/developer-platform';
import { nestContext } from '../shared/nest-context';
import { processBatch, SqsBatchResponse, SqsEvent } from '../shared/sqs-batch';
import { metric } from '../shared/telemetry';

@Module({ imports: [ApiConfigModule, PlatformModule, DatabaseModule, RedisModule, WebhooksCoreModule] })
class WebhookLambdaModule {}

/**
 * SD-30 delivery as a Lambda on the FIFO queue (batch ≤ 10,
 * ReportBatchItemFailures). Nest context cached per container. Idempotency
 * comes from the deliverer itself (per-delivery "sent" markers + FIFO dedupe),
 * so no extra Idempotency table here.
 */
export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  const deliverer = (await nestContext(WebhookLambdaModule)).get(WebhookDeliverer);
  return processBatch(event, async (record) => {
    const started = Date.now();
    const outcome = await deliverer.deliver(JSON.parse(record.body) as WebhookDelivery, Number(record.attributes.ApproximateReceiveCount));
    metric('Marketplace/Webhooks', 'DeliveryMs', Date.now() - started, 'Milliseconds', { outcome });
    if (outcome === 'retry-fifo') throw new Error('redeliver');
  });
}
