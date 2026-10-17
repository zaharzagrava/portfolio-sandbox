import type { TaskMessage } from '@app/infrastructure/sqs/task-queue.port';
import { PermanentError, TransientError } from '../errors';
import { AlreadyInProgressError } from '../idempotency/idempotency-errors';
import {
  log,
  metric,
  telemetryNow,
  TOOLKIT_NAMESPACE,
  withInvocationFields,
} from '../telemetry/telemetry';
import { withConsumerSpan } from '../telemetry/trace';
import { errorName, processBatch } from './sqs-batch';
import type {
  InvocationContext,
  SqsBatchResponse,
  SqsEvent,
  SqsRecord,
} from './sqs-types';

/** What the toolkit needs to know about the function it wraps (a manifest entry carries it). */
export interface FunctionInfo {
  name: string;
  queue: string;
  fifo: boolean;
  maxReceiveCount: number;
}

export interface BodySchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error?: unknown };
}

export interface DefineSqsHandlerOptions<T, C> {
  function: FunctionInfo;
  /** A body that is not JSON or fails this never reaches `handle` (permanent failure of that record). */
  bodySchema?: BodySchema<T>;
  /** Runs once per invocation before any record (a cached Nest context); a rejection fails the whole invocation. */
  init?: () => Promise<C>;
  handle: (
    message: TaskMessage<T>,
    context: C,
    record: SqsRecord,
  ) => Promise<void>;
  /**
   * For a queue where retrying an unreadable body can never help and would loop (a dead-letter queue): the record is
   * acknowledged after this call instead of being reported failed. Default: an invalid body is a permanent failure.
   */
  onInvalidBody?: (record: SqsRecord, reason: string) => void;
  concurrency?: number;
  deadlineMarginMs?: number;
}

export type FailureClass = 'permanent' | 'transient' | 'in_progress';

export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof AlreadyInProgressError) return 'in_progress';
  if (error instanceof PermanentError) return 'permanent';
  if (error instanceof TransientError) return 'transient';
  return 'transient';
}

/** Message attributes as the flat string map of the task-queue port. */
export function attributesOf(record: SqsRecord): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record.messageAttributes ?? {}).flatMap(([k, v]) =>
      v.stringValue === undefined ? [] : [[k, v.stringValue]],
    ),
  );
}

/**
 * A Lambda entry point for one SQS function: the same task message every worker consumer gets (S53), bodies validated
 * before domain code runs, per-record failure reporting (`processBatch`), receive-limit awareness, trace continuation
 * and safe logs (message id, function, queue, receive count, error class and message; never the body).
 */
export function defineSqsHandler<T = unknown, C = void>(
  options: DefineSqsHandlerOptions<T, C>,
): (event: SqsEvent, context?: InvocationContext) => Promise<SqsBatchResponse> {
  const info = options.function;
  const dims = { function: info.name, queue: info.queue };

  return async (event, invocation) => {
    const started = telemetryNow();
    const ctx = (await options.init?.()) as C;

    const response = await processBatch(
      event,
      async (record) => {
        const attributes = attributesOf(record);
        await withConsumerSpan(
          `${info.name} process`,
          attributes.traceparent,
          (_span, traceId) =>
            withInvocationFields(
              { messageId: record.messageId, traceId },
              async () => {
                let body: T;
                try {
                  body = parseBody(record, options.bodySchema);
                } catch (error) {
                  if (
                    error instanceof InvalidBodyError &&
                    options.onInvalidBody
                  ) {
                    options.onInvalidBody(record, error.message);
                    return;
                  }
                  throw error;
                }
                await options.handle(
                  {
                    id: record.messageId,
                    body,
                    receiveCount: Number(
                      record.attributes.ApproximateReceiveCount,
                    ),
                    attributes,
                  },
                  ctx,
                  record,
                );
                metric(TOOLKIT_NAMESPACE, 'RecordsProcessed', 1, 'Count', dims);
              },
            ),
        );
      },
      {
        concurrency: options.concurrency,
        deadlineMarginMs: options.deadlineMarginMs,
        remainingTimeMs:
          invocation && (() => invocation.getRemainingTimeInMillis()),
        onFailure: (record, error) => reportFailure(info, dims, record, error),
        onSkipped: (record, reason) =>
          log('warn', 'record not run', {
            messageId: record.messageId,
            function: info.name,
            queue: info.queue,
            reason,
          }),
      },
    );
    metric(
      TOOLKIT_NAMESPACE,
      'InvocationMs',
      telemetryNow() - started,
      'Milliseconds',
      dims,
    );
    return response;
  };
}

/** The body is not JSON, or fails the declared schema: it never reaches the business handler. */
export class InvalidBodyError extends PermanentError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBodyError';
  }
}

function parseBody<T>(record: SqsRecord, schema: BodySchema<T> | undefined): T {
  let json: unknown;
  try {
    json = JSON.parse(record.body);
  } catch {
    throw new InvalidBodyError('body is not valid JSON');
  }
  if (!schema) return json as T;
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new InvalidBodyError('body does not match the schema');
  return parsed.data;
}

function reportFailure(
  info: FunctionInfo,
  dims: { function: string; queue: string },
  record: SqsRecord,
  error: unknown,
): void {
  const receiveCount = Number(record.attributes.ApproximateReceiveCount);
  const failureClass = classifyFailure(error);
  const lastAttempt = receiveCount >= info.maxReceiveCount;
  log('warn', 'record failed', {
    messageId: record.messageId,
    function: info.name,
    queue: info.queue,
    receiveCount,
    errorClass: errorName(error),
    error: error instanceof Error ? error.message : String(error),
    failureClass,
  });
  metric(TOOLKIT_NAMESPACE, 'RecordsFailed', 1, 'Count', {
    ...dims,
    outcome: failureClass,
  });
  if (lastAttempt) {
    log('error', 'record will be dead-lettered', {
      messageId: record.messageId,
      function: info.name,
      queue: info.queue,
      receiveCount,
    });
    metric(TOOLKIT_NAMESPACE, 'DeadLettered', 1, 'Count', dims);
    if (info.fifo)
      metric(TOOLKIT_NAMESPACE, 'FifoGroupOrderBroken', 1, 'Count', dims);
  }
}
