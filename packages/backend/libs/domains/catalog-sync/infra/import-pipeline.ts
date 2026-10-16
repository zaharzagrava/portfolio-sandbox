import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ImportPipelineOptions<T> {
  /** The bytes of the file (or any readable): destroyed on every exit path. */
  source: Readable;
  /** Lazy stages (async generators): each yields only what the next one pulls. */
  stages?: Array<(input: AsyncIterable<any>) => AsyncIterable<any>>;
  /** The batcher/writer: pulls records one at a time, so a slow write pauses the source. */
  consume: (
    records: AsyncIterable<T>,
    context: { signal: AbortSignal },
  ) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * source -> parser -> batcher/writer as one `stream.pipeline` (S07 D-06, FR-015/FR-016). Backpressure is the pull
 * model: the consumer holds at most one batch of records while it writes, and the object queue between stages holds at
 * most 16, so a blocked sink never lets more than 500 + 16 records be pulled. An error in any stage, or the abort
 * signal, destroys every stage and the source before the promise settles.
 */
export function runImportPipeline<T>(
  options: ImportPipelineOptions<T>,
): Promise<void> {
  const steps = [
    options.source,
    ...(options.stages ?? []),
    options.consume,
  ] as unknown as Parameters<typeof pipeline>;
  return pipeline(...steps, {
    signal: options.signal,
  } as never) as Promise<void>;
}
