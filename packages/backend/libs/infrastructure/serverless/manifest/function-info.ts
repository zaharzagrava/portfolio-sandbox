import type { FunctionInfo } from '../batch/define-sqs-handler';
import { expandManifest, type ManifestEntry } from './lambda-spec';
import { LAMBDAS } from './lambdas.manifest';

/** The manifest entry of a function (a dead-letter handler is `<name>-dlq`). Throws for a name that is not in it. */
export function manifestEntry(name: string): ManifestEntry {
  const entry = expandManifest(LAMBDAS).find((e) => e.name === name);
  if (!entry) throw new Error(`"${name}" is not in the Lambda manifest`);
  return entry;
}

/**
 * What `defineSqsHandler` needs, read from the manifest so an entry file states no queue number of its own. A
 * dead-letter handler has no dead-letter queue of its own, so its receive limit is unbounded (it never reports
 * `DeadLettered`; a failure there is `DeadLetterHandlerFailed`).
 */
export function functionInfo(name: string): FunctionInfo {
  const entry = manifestEntry(name);
  return {
    name: entry.name,
    queue: entry.queue,
    fifo: entry.fifo,
    maxReceiveCount: entry.deadLetterOf
      ? Number.POSITIVE_INFINITY
      : entry.maxReceiveCount,
  };
}

/** The idempotency lease for a function: its timeout plus a margin for the completion write. */
export function leaseMsOf(name: string): number {
  return manifestEntry(name).timeoutSec * 1000 + 15_000;
}
