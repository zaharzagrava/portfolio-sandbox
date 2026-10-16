import type { SqsBatchResponse, SqsEvent } from '../shared/sqs-batch';
import * as webhookDelivery from './webhook-delivery';
import * as mediaProcessing from './media-processing';
import * as documentExtractor from './document-extractor';
import * as documentExtractorDlq from './document-extractor-dlq';

type Handler = (event: SqsEvent) => Promise<SqsBatchResponse>;

/**
 * Registry for apps/lambda-local (static imports, so the bundler includes every handler).
 * Deployed Lambdas don't use it: each is bundled from its own entry file (scripts/build-lambdas.mjs).
 */
export const HANDLERS: Record<string, () => Promise<{ handler: Handler }>> = {
  'webhook-delivery': () => Promise.resolve(webhookDelivery),
  'media-processing': () => Promise.resolve(mediaProcessing),
  'document-extractor': () => Promise.resolve(documentExtractor),
  'document-extractor-dlq': () => Promise.resolve(documentExtractorDlq),
};
