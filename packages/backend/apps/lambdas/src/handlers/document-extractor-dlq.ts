import { RequestContext } from '@app/infrastructure/context';
import { nestContext } from '../shared/nest-context';
import { processBatch, SqsBatchResponse, SqsEvent } from '../shared/sqs-batch';
import { metric } from '../shared/telemetry';
import {
  ExtractionService,
  extractDocumentBody,
} from '@app/domains/seller-onboarding';
import { DocumentExtractorModule } from './document-extractor';

/**
 * The dead-letter handler of `onboarding-documents` (S04 FR-026, A9): a message parked after five receives sends its
 * document to human review with `extraction_unavailable`, so no document is lost and none stays `EXTRACTING` forever.
 * Idempotent (running it again changes nothing). A body that is not `{documentId: uuid}` can never be routed and retrying
 * it would loop in the DLQ: it is acknowledged and counted. The alarm metric `DeadLettered` is what pages an operator.
 */
export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  const context = await nestContext(DocumentExtractorModule);
  const extraction = context.get(ExtractionService);
  const requests = context.get(RequestContext);
  return processBatch(event, (record) =>
    requests.run({ requestId: record.messageId }, async () => {
      let documentId: string;
      try {
        documentId = extractDocumentBody.parse(
          JSON.parse(record.body),
        ).documentId;
      } catch {
        metric('Marketplace/KYC', 'InvalidDeadLetters', 1, 'Count', {});
        return;
      }
      await extraction.routeToReview(documentId, 'extraction_unavailable');
      metric('Marketplace/KYC', 'DeadLettered', 1, 'Count', {});
    }),
  );
}
