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
import {
  defineSqsHandler,
  functionInfo,
  manifestEntry,
  metric,
  TransientError,
} from '@app/infrastructure/serverless';
import { nestContext } from '@app/infrastructure/serverless/context';

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

/** The extraction context of this function (cached per container) with the pool size of the manifest. */
export const extractionContext = () =>
  nestContext(DocumentExtractorModule, {
    dbPoolMax: manifestEntry('document-extractor').dbPoolMax,
  });

/**
 * SD-44 KYC extraction on the `onboarding-documents` queue (Nest context cached per container, Q6). Partial batch
 * failures: a body that is not `{documentId: uuid}` is a failed item with no side effect and does not block the rest of
 * the batch (S04 FR-027); a provider outage fails only the affected records, SQS retries them with the queue's backoff
 * and parks poison messages in the DLQ (handled by `document-extractor-dlq`). maxConcurrency in the manifest is the
 * provider's tokens/min budget expressed in containers. Idempotency is the service's own: per-document status claim with
 * a lease + per-attempt rows, so a redelivered message resumes instead of re-paying for attempt 1.
 */
export const handler = defineSqsHandler({
  function: functionInfo('document-extractor'),
  bodySchema: extractDocumentBody,
  init: async () => {
    const context = await extractionContext();
    return {
      extraction: context.get(ExtractionService),
      requests: context.get(RequestContext),
    };
  },
  handle: async (message, { extraction, requests }) => {
    const started = Date.now();
    // each message runs in its own request context, so its log lines carry the message id (AS-67)
    await requests.run({ requestId: message.id }, async () => {
      try {
        await extraction.process(message.body.documentId);
        metric(
          'Marketplace/KYC',
          'ExtractionMs',
          Date.now() - started,
          'Milliseconds',
          { outcome: 'ok' },
        );
      } catch (error) {
        const transient = error instanceof TransientError;
        metric('Marketplace/KYC', 'ExtractionErrors', 1, 'Count', {
          kind: transient ? 'provider' : 'other',
        });
        throw error;
      }
    });
  },
});
