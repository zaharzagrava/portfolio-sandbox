/**
 * One source of truth for every Lambda: the local runner (apps/lambda-local),
 * the bundler (scripts/build-lambdas.mjs) and Terraform (O-03 reads the JSON
 * emitted by the build) all use this list.
 * Visibility timeout ≥ 6 × function timeout (AWS guidance for SQS event sources).
 */
export interface LambdaSpec {
  name: string;
  /** Path of the compiled handler module, relative to dist/apps/lambdas. */
  entry: string;
  queue: string;
  timeoutSec: number;
  memoryMb: number;
  batchSize: number;
  /** Caps parallel containers → caps DB connections (with RDS Proxy in front). */
  maxConcurrency: number;
}

export const LAMBDAS: LambdaSpec[] = [
  {
    name: 'webhook-delivery',
    entry: 'handlers/webhook-delivery.js',
    queue: 'webhook-deliveries.fifo',
    timeoutSec: 30,
    memoryMb: 512,
    batchSize: 10,
    maxConcurrency: 200,
  },
  {
    name: 'media-processing',
    entry: 'handlers/media-processing.js',
    queue: 'media-processing',
    timeoutSec: 60,
    memoryMb: 1536,
    batchSize: 5,
    maxConcurrency: 100,
  },
  // Two model calls worst case per document; concurrency sized to the LLM tokens/min budget, not to the queue depth.
  {
    name: 'document-extractor',
    entry: 'handlers/document-extractor.js',
    queue: 'onboarding-documents',
    timeoutSec: 120,
    memoryMb: 512,
    batchSize: 2,
    maxConcurrency: 20,
  },
];
