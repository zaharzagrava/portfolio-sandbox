import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { DatabaseModule } from '@app/infrastructure/database';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { PlatformModule } from '@app/infrastructure/platform';
import { RequestContext } from '@app/infrastructure/context';
import {
  OnboardingExtractionModule,
  ExtractionService,
  extractDocumentBody,
} from '@app/domains/seller-onboarding';
import { LlmUnavailableError } from '@app/infrastructure/llm';
import { nestContext } from '../shared/nest-context';
import {
  processBatch,
  SqsBatchResponse,
  SqsEvent,
  SqsRecord,
} from '../shared/sqs-batch';
import { metric } from '../shared/telemetry';

/**
 * The standalone app of this Lambda (L-018): the extraction module only. No ClickHouse, Kafka producer or billing module
 * is imported - metering is the outbox record of the LLM port, relayed by the platform.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    OnboardingExtractionModule,
  ],
})
export class DocumentExtractorModule {}

/**
 * SD-44 KYC extraction on the `onboarding-documents` queue (Nest context cached per container, Q6). Partial batch
 * failures: a body that is not `{documentId: uuid}` is a failed item with no side effect and does not block the rest of
 * the batch (S04 FR-027); a provider outage fails only the affected records, SQS retries them with the queue's backoff
 * and parks poison messages in the DLQ (handled by `document-extractor-dlq`). maxConcurrency in the manifest is the
 * provider's tokens/min budget expressed in containers. Idempotency is the service's own: per-document status claim with
 * a lease + per-attempt rows, so a redelivered message resumes instead of re-paying for attempt 1.
 */
export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  const context = await nestContext(DocumentExtractorModule);
  const extraction = context.get(ExtractionService);
  const requests = context.get(RequestContext);
  // each message runs in its own request context, so its log lines carry the message id (AS-67)
  return processBatch(event, (record) =>
    requests.run({ requestId: record.messageId }, () =>
      handleRecord(extraction, record),
    ),
  );
}

async function handleRecord(
  extraction: ExtractionService,
  record: SqsRecord,
): Promise<void> {
  const started = Date.now();
  let documentId: string;
  try {
    documentId = extractDocumentBody.parse(JSON.parse(record.body)).documentId;
  } catch {
    metric('Marketplace/KYC', 'InvalidMessages', 1, 'Count', {});
    throw new Error('invalid onboarding-documents message');
  }
  try {
    await extraction.process(documentId);
    metric(
      'Marketplace/KYC',
      'ExtractionMs',
      Date.now() - started,
      'Milliseconds',
      { outcome: 'ok' },
    );
  } catch (error) {
    metric('Marketplace/KYC', 'ExtractionErrors', 1, 'Count', {
      kind: error instanceof LlmUnavailableError ? 'provider' : 'other',
    });
    throw error;
  }
}
