import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type {
  InvocationContext,
  SqsBatchResponse,
  SqsEvent,
} from '../batch/sqs-types';
import { buildEvent } from './event-builder';
import type { ManifestEntry } from '../manifest/lambda-spec';
import { validateManifest } from '../manifest/validate-manifest';
import { log } from '../telemetry/telemetry';

export type LambdaHandler = (
  event: SqsEvent,
  context: InvocationContext,
) => Promise<SqsBatchResponse>;

export interface RunnerClock {
  now(): number;
  /** Resolves after `ms` (or at once when the signal aborts). Tests record the delays and resolve immediately. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: RunnerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    }),
};

export interface RunnerOptions {
  /** `dist/lambda-bundles/manifest.json`. */
  manifestPath: string;
  sqs: Pick<SQSClient, 'send'>;
  /** Queue URL = prefix + queue name (default `<endpoint>/000000000000/`). */
  queueUrlPrefix: string;
  region?: string;
  clock?: RunnerClock;
  /** Cap on parallel invocations per function (`LAMBDA_LOCAL_MAX_CONCURRENCY`, default 2). */
  maxConcurrency?: number;
  /** Start only these functions (default all). */
  only?: string[];
  /** Long-poll wait in seconds (default 20). */
  waitTimeSeconds?: number;
  /** Loads the handler of a function; the default requires `<bundles>/<name>/index.js`. Throws when it is missing. */
  loadHandler?: (entry: ManifestEntry, bundlesDir: string) => LambdaHandler;
  signal?: AbortSignal;
}

export class RunnerStartupError extends Error {
  constructor(readonly problems: string[]) {
    super(`lambda-local cannot start: ${problems.join('; ')}`);
    this.name = 'RunnerStartupError';
  }
}

export interface RunnerHandle {
  /** Stops receiving, waits for in-flight invocations (bounded by the function timeout) and deletes their successes. */
  stop(): Promise<void>;
  /** Settles when every polling loop has ended. */
  finished: Promise<void>;
}

export const BACKOFF_START_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

function defaultLoadHandler(
  entry: ManifestEntry,
  bundlesDir: string,
): LambdaHandler {
  const path = join(bundlesDir, entry.name, 'index.js');
  if (!existsSync(path)) throw new Error(`no bundle at ${path}`);
  // `createRequire` keeps a bundler (the launcher is built with webpack) from trying to resolve the path statically
  const loaded = createRequire(path)(path) as { handler?: LambdaHandler };
  if (typeof loaded.handler !== 'function')
    throw new Error(`${path} does not export a handler function`);
  return loaded.handler;
}

interface Prepared {
  entry: ManifestEntry;
  handler: LambdaHandler;
  queueUrl: string;
  arn: string;
  concurrency: number;
}

/**
 * Local stand-in for the Lambda service with an SQS event source (D19), started from the BUILT bundles and
 * `manifest.json` so what runs locally is what is deployed. It validates everything before the first receive, then
 * long-polls each function's queue with up to `maxConcurrency` pollers (capped), builds the exact record shape, invokes
 * the handler, deletes only the records not reported in `batchItemFailures` (nothing on throw or timeout; the queue's
 * own visibility timeout redelivers, nothing is extended) and survives broker outages with capped backoff.
 */
export async function startRunner(
  options: RunnerOptions,
): Promise<RunnerHandle> {
  const clock = options.clock ?? systemClock;
  const region = options.region ?? 'eu-central-1';
  const cap = options.maxConcurrency ?? 2;
  const waitTimeSeconds = options.waitTimeSeconds ?? 20;
  const bundlesDir = dirname(options.manifestPath);
  const load = options.loadHandler ?? defaultLoadHandler;
  const problems: string[] = [];

  let manifest: ManifestEntry[] = [];
  try {
    manifest = JSON.parse(
      readFileSync(options.manifestPath, 'utf8'),
    ) as ManifestEntry[];
    validateManifest(manifest);
  } catch (error) {
    problems.push(
      `manifest ${options.manifestPath}: ${(error as Error).message}`,
    );
  }
  const names = new Set(manifest.map((e) => e.name));
  for (const wanted of options.only ?? [])
    if (!names.has(wanted)) problems.push(`${wanted}: not in the manifest`);
  const selected = manifest.filter(
    (e) => !options.only?.length || options.only.includes(e.name),
  );

  const prepared: Prepared[] = [];
  for (const entry of selected) {
    let handler: LambdaHandler | undefined;
    try {
      handler = load(entry, bundlesDir);
    } catch (error) {
      problems.push(`${entry.name}: ${(error as Error).message}`);
    }
    const queueUrl = `${options.queueUrlPrefix}${entry.queue}`;
    let arn = '';
    try {
      const attributes = (
        await options.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ['QueueArn', 'VisibilityTimeout'],
          }),
        )
      ).Attributes;
      arn =
        attributes?.QueueArn ??
        `arn:aws:sqs:${region}:000000000000:${entry.queue}`;
      const visibility = Number(attributes?.VisibilityTimeout ?? 0);
      if (visibility < 6 * entry.timeoutSec)
        problems.push(
          `${entry.name}: queue ${entry.queue} visibility ${visibility} s is below 6 × the function timeout (${6 * entry.timeoutSec} s)`,
        );
    } catch (error) {
      problems.push(
        `${entry.name}: queue ${entry.queue} is not available (${(error as Error).name})`,
      );
    }
    if (handler)
      prepared.push({
        entry,
        handler,
        queueUrl,
        arn,
        concurrency: Math.max(1, Math.min(entry.maxConcurrency, cap)),
      });
  }
  if (problems.length) throw new RunnerStartupError(problems);

  const stopping = new AbortController();
  options.signal?.addEventListener('abort', () => stopping.abort(), {
    once: true,
  });
  const inFlight = new Set<Promise<void>>();

  const loops = prepared.flatMap((fn) =>
    Array.from({ length: fn.concurrency }, () => poll(fn)),
  );
  for (const fn of prepared)
    log('info', 'lambda-local started', {
      function: fn.entry.name,
      queue: fn.entry.queue,
      concurrency: fn.concurrency,
    });

  async function poll(fn: Prepared): Promise<void> {
    let backoff = BACKOFF_START_MS;
    while (!stopping.signal.aborted) {
      let messages: Message[];
      try {
        messages =
          (
            await options.sqs.send(
              new ReceiveMessageCommand({
                QueueUrl: fn.queueUrl,
                MaxNumberOfMessages: Math.min(fn.entry.batchSize, 10),
                WaitTimeSeconds: waitTimeSeconds,
                MessageSystemAttributeNames: ['All'],
                MessageAttributeNames: ['All'],
              }),
              { abortSignal: stopping.signal },
            )
          ).Messages ?? [];
        backoff = BACKOFF_START_MS;
      } catch (error) {
        if (stopping.signal.aborted) return;
        log('error', 'lambda-local receive failed; backing off', {
          function: fn.entry.name,
          error: (error as Error).name,
          backoffMs: backoff,
        });
        await clock.sleep(backoff, stopping.signal);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        continue;
      }
      if (messages.length === 0) continue;
      const work = invoke(fn, messages).catch((error) =>
        log('error', 'lambda-local batch handling failed', {
          function: fn.entry.name,
          error: (error as Error).message,
        }),
      );
      inFlight.add(work);
      try {
        await work;
      } finally {
        inFlight.delete(work);
      }
    }
  }

  async function invoke(fn: Prepared, messages: Message[]): Promise<void> {
    const event = buildEvent(messages, { arn: fn.arn, region });
    const deadline = clock.now() + fn.entry.timeoutSec * 1000;
    let failed = new Set(event.Records.map((r) => r.messageId));
    const execution = fn.handler(event, {
      getRemainingTimeInMillis: () => Math.max(0, deadline - clock.now()),
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${fn.entry.name} timed out after ${fn.entry.timeoutSec}s`,
            ),
          ),
        fn.entry.timeoutSec * 1000,
      );
    });
    try {
      const result = await Promise.race([execution, timeout]);
      failed = new Set(result.batchItemFailures.map((f) => f.itemIdentifier));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        'error',
        `lambda-local ${fn.entry.name} invocation failed - the whole batch will be redelivered`,
        {
          function: fn.entry.name,
          error: message,
        },
      );
      if (/timed out after/.test(message)) {
        log('error', 'abandoned_invocation', {
          function: fn.entry.name,
          records: event.Records.length,
        });
        execution.catch(() => undefined); // the handler cannot be killed in-process; never leave a rejection unhandled
      }
    } finally {
      clearTimeout(timer);
    }
    const done = event.Records.filter((r) => !failed.has(r.messageId));
    if (done.length === 0) return;
    try {
      const deleted = await options.sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: fn.queueUrl,
          Entries: done.map((r, i) => ({
            Id: String(i),
            ReceiptHandle: r.receiptHandle,
          })),
        }),
      );
      for (const entry of deleted.Failed ?? [])
        log(
          'error',
          'lambda-local delete failed; the message will be redelivered',
          {
            function: fn.entry.name,
            messageId: done[Number(entry.Id)]?.messageId,
            code: entry.Code,
          },
        );
    } catch (error) {
      log(
        'error',
        'lambda-local delete call failed; the messages will be redelivered',
        {
          function: fn.entry.name,
          error: (error as Error).name,
        },
      );
    }
  }

  const finished = Promise.all(loops).then(() => undefined);
  return {
    finished,
    async stop() {
      stopping.abort();
      await Promise.all([...inFlight]);
      await finished;
    },
  };
}
