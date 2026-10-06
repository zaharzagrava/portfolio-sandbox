import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { DatabaseModule } from '@app/infrastructure/database/database.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { PlatformModule } from '@app/infrastructure/platform/platform.module';
import { OnboardingExtractionModule, ExtractionService } from '@app/domains/seller-onboarding';
import { LlmUnavailableError } from '@app/domains/assistant';
import { nestContext } from '../shared/nest-context';
import { processBatch, SqsBatchResponse, SqsEvent } from '../shared/sqs-batch';
import { metric } from '../shared/telemetry';

@Module({ imports: [ApiConfigModule, PlatformModule, DatabaseModule, RedisModule, OnboardingExtractionModule] })
class DocumentExtractorModule {}

/**
 * SD-44 KYC extraction on the `onboarding-documents` queue (Nest context
 * cached per container, Q6). Partial batch failures: a provider outage fails
 * only the affected records; SQS retries them with the queue's backoff and
 * parks poison messages in the DLQ (alarmed, O-03). maxConcurrency in the
 * manifest is the provider's tokens/min budget expressed in containers.
 * Idempotency is the service's own: per-document status claim + per-attempt
 * rows, so a redelivered message resumes instead of re-paying for attempt 1.
 */
export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  const extraction = (await nestContext(DocumentExtractorModule)).get(ExtractionService);
  return processBatch(event, async (record) => {
    const started = Date.now();
    const { documentId } = JSON.parse(record.body) as { documentId: string };
    try {
      await extraction.process(documentId);
      metric('Marketplace/KYC', 'ExtractionMs', Date.now() - started, 'Milliseconds', { outcome: 'ok' });
    } catch (error) {
      metric('Marketplace/KYC', 'ExtractionErrors', 1, 'Count', { kind: error instanceof LlmUnavailableError ? 'provider' : 'other' });
      throw error;
    }
  });
}
