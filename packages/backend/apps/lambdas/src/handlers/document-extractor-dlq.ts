import { RequestContext } from '@app/infrastructure/context';
import {
  ExtractionService,
  extractDocumentBody,
} from '@app/domains/seller-onboarding';
import {
  defineSqsHandler,
  functionInfo,
  idempotencyFor,
  idempotencyKey,
  leaseMsOf,
  metric,
} from '@app/infrastructure/serverless';
import { extractionContext } from './document-extractor';

const NAME = 'document-extractor-dlq';
const idempotency = idempotencyFor(NAME);

/**
 * The dead-letter handler of `onboarding-documents` (S04 FR-026, A9; S55 FR-045): a message parked after five receives
 * sends its document to human review with `extraction_unavailable`, so no document is lost and none stays `EXTRACTING`
 * forever. It runs once per document (an idempotency record keyed by the document, so a duplicate delivery changes
 * nothing; the service is idempotent too). A body that is not `{documentId: uuid}` can never be routed and retrying it
 * would loop in the DLQ: it is acknowledged and counted. When routing fails the message stays in the DLQ (the record is
 * reported failed and retried after the visibility timeout) and `DeadLetterHandlerFailed` is emitted. The alarm metric
 * `DeadLettered` is what pages an operator.
 */
export const handler = defineSqsHandler({
  function: functionInfo(NAME),
  bodySchema: extractDocumentBody,
  onInvalidBody: () =>
    metric('Marketplace/KYC', 'InvalidDeadLetters', 1, 'Count', {}),
  init: async () => {
    const context = await extractionContext();
    return {
      extraction: context.get(ExtractionService),
      requests: context.get(RequestContext),
    };
  },
  handle: async (message, { extraction, requests }) => {
    const { documentId } = message.body;
    try {
      await requests.run({ requestId: message.id }, () =>
        // document IDs are globally unique UUIDs, so the key needs no tenant part (S55 research D-4)
        idempotency.run(
          idempotencyKey(NAME, documentId),
          () => extraction.routeToReview(documentId, 'extraction_unavailable'),
          { leaseMs: leaseMsOf(NAME) },
        ),
      );
      metric('Marketplace/KYC', 'DeadLettered', 1, 'Count', {});
    } catch (error) {
      metric('Marketplace/Lambda', 'DeadLetterHandlerFailed', 1, 'Count', {
        function: NAME,
      });
      throw error;
    }
  },
});
