/**
 * One source of truth for every Lambda: the local runner (`runner/`), the bundler (scripts/build-lambdas.mjs) and
 * Terraform (O-03 reads the `manifest.json` emitted by the build) all use this shape. The queue numbers in it are
 * checked against `infra/docker/elasticmq.conf` and the `queues` map of `infra/stack/main.tf`.
 */
export interface DeadLetterSpec {
  /** Path of the compiled handler module of the dead-letter handler, relative to dist/apps/lambdas. */
  entry: string;
  batchSize: number;
  maxConcurrency: number;
  /** Defaults: 45 s, 512 MB, visibility 6 × timeout. */
  timeoutSec?: number;
  memoryMb?: number;
  visibilityTimeoutSec?: number;
}

export interface LambdaSpec {
  name: string;
  /** Path of the compiled handler module, relative to dist/apps/lambdas. */
  entry: string;
  queue: string;
  /** Must equal the `.fifo` suffix of `queue`. */
  fifo: boolean;
  timeoutSec: number;
  memoryMb: number;
  batchSize: number;
  /** Caps parallel containers → caps DB connections (with RDS Proxy in front). */
  maxConcurrency: number;
  /** Visibility timeout of the queue: at least 6 × `timeoutSec` (AWS guidance for SQS event sources). */
  visibilityTimeoutSec: number;
  /** Receives before the queue moves a message to its dead-letter queue. */
  maxReceiveCount: number;
  /** Database connections one container holds; the budget sums `maxConcurrency × dbPoolMax`. Default 2. */
  dbPoolMax?: number;
  /**
   * A plain handler: no Nest. Its bundle must contain no Nest core, so the build gives it the framework-free part of a
   * domain barrel (`PLAIN_BARRELS` in `scripts/build-lambdas.mjs`) instead of the barrel that also exports Nest modules.
   */
  plain?: boolean;
  /** FIFO-only producer option; setting it on a standard queue is rejected (L-001). */
  groupId?: string;
  /** A function on this queue's dead-letter queue. The build expands it into the function `<name>-dlq`. */
  deadLetter?: DeadLetterSpec;
}

/** An element of `manifest.json`: a source entry, or the expansion of a dead-letter handler (`deadLetterOf`). */
export interface ManifestEntry extends LambdaSpec {
  deadLetterOf?: string;
}

export const DEFAULT_DB_POOL_MAX = 2;
export const DEFAULT_DEAD_LETTER_TIMEOUT_SEC = 45;
export const DEFAULT_DEAD_LETTER_MEMORY_MB = 512;

/** `onboarding-documents` → `onboarding-documents-dlq`; `webhook-deliveries.fifo` → `webhook-deliveries-dlq.fifo`. */
export function dlqQueueName(queue: string): string {
  return queue.endsWith('.fifo')
    ? `${queue.slice(0, -'.fifo'.length)}-dlq.fifo`
    : `${queue}-dlq`;
}

/**
 * The manifest as the build emits it: every source entry, followed by one entry per `deadLetter` (name `<name>-dlq`,
 * on the dead-letter queue, same FIFO flag and receive limit). Idempotent: an already expanded list is returned as is.
 */
export function expandManifest(specs: LambdaSpec[]): ManifestEntry[] {
  const names = new Set(specs.map((s) => s.name));
  const out: ManifestEntry[] = [...specs];
  for (const spec of specs) {
    const dead = spec.deadLetter;
    if (!dead || names.has(`${spec.name}-dlq`)) continue;
    const timeoutSec = dead.timeoutSec ?? DEFAULT_DEAD_LETTER_TIMEOUT_SEC;
    out.push({
      name: `${spec.name}-dlq`,
      entry: dead.entry,
      queue: dlqQueueName(spec.queue),
      fifo: spec.fifo,
      timeoutSec,
      memoryMb: dead.memoryMb ?? DEFAULT_DEAD_LETTER_MEMORY_MB,
      batchSize: dead.batchSize,
      maxConcurrency: dead.maxConcurrency,
      visibilityTimeoutSec: dead.visibilityTimeoutSec ?? 6 * timeoutSec,
      maxReceiveCount: spec.maxReceiveCount,
      dbPoolMax: spec.dbPoolMax,
      deadLetterOf: spec.name,
    });
  }
  return out;
}
