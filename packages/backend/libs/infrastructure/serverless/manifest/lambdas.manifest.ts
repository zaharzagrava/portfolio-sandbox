import type { LambdaSpec } from './lambda-spec';

/**
 * The functions. A new function is one entry here plus one entry file in `apps/lambdas/src/handlers` (SC-008).
 * Visibility timeout ≥ 6 × function timeout; the same numbers are in `infra/docker/elasticmq/elasticmq.conf` and
 * `infra/stack/main.tf` (checked by `queue-config-conformance.spec.ts`).
 */
export const LAMBDAS: LambdaSpec[] = [
  {
    name: 'webhook-delivery',
    entry: 'handlers/webhook-delivery.js',
    queue: 'webhook-deliveries.fifo',
    fifo: true,
    timeoutSec: 30,
    memoryMb: 512,
    batchSize: 10,
    maxConcurrency: 200,
    visibilityTimeoutSec: 180,
    maxReceiveCount: 5,
    dbPoolMax: 2,
  },
  {
    name: 'media-processing',
    entry: 'handlers/media-processing.js',
    queue: 'media-processing',
    fifo: false,
    timeoutSec: 60,
    memoryMb: 1536,
    batchSize: 5,
    maxConcurrency: 100,
    visibilityTimeoutSec: 360,
    maxReceiveCount: 3,
    dbPoolMax: 2,
    plain: true,
  },
  // Two model calls worst case per document; concurrency sized to the LLM tokens/min budget, not to the queue depth.
  // S04 FR-026: a message parked after 5 receives sends its document to human review (`extraction_unavailable`).
  {
    name: 'document-extractor',
    entry: 'handlers/document-extractor.js',
    queue: 'onboarding-documents',
    fifo: false,
    timeoutSec: 120,
    memoryMb: 512,
    batchSize: 2,
    maxConcurrency: 20,
    visibilityTimeoutSec: 720,
    maxReceiveCount: 5,
    dbPoolMax: 2,
    deadLetter: {
      entry: 'handlers/document-extractor-dlq.js',
      batchSize: 5,
      maxConcurrency: 5,
    },
  },
];
