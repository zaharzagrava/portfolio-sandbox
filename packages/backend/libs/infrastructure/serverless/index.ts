/**
 * Lambda workers toolkit (S55): partial batch failure, idempotent effects, the manifest, the local runner.
 * Entry files in `apps/lambdas` import from here. The Nest context cache (`./context`) and the local runner
 * (`./runner`) have their own entries, so a plain handler's bundle contains neither Nest nor the SQS client.
 */
export { processBatch } from './batch/sqs-batch';
export type { ProcessBatchOptions } from './batch/sqs-batch';
export type {
  InvocationContext,
  SqsBatchResponse,
  SqsEvent,
  SqsRecord,
} from './batch/sqs-types';
export {
  attributesOf,
  classifyFailure,
  defineSqsHandler,
} from './batch/define-sqs-handler';
export type {
  DefineSqsHandlerOptions,
  FailureClass,
  FunctionInfo,
} from './batch/define-sqs-handler';

export { PermanentError, TransientError } from './errors';
export { Idempotency, MAX_RESULT_BYTES } from './idempotency/idempotency';
export type { IdempotencyOptions, RunResult } from './idempotency/idempotency';
export {
  AlreadyInProgressError,
  IdempotencyKeyConflictError,
  InvalidIdempotencyKeyError,
  InvalidIdempotencyOptionsError,
  StaleClaimError,
} from './idempotency/idempotency-errors';
export { idempotencyKey } from './idempotency/idempotency-key';
export { idempotencyFor } from './idempotency/idempotency-store';
export type { RunOptions } from './idempotency/idempotency-options';

export {
  configureTelemetry,
  log,
  metric,
  TOOLKIT_NAMESPACE,
  withInvocationFields,
} from './telemetry/telemetry';
export { parseTraceparent, withConsumerSpan } from './telemetry/trace';

export { LAMBDAS } from './manifest/lambdas.manifest';
export { dlqQueueName, expandManifest } from './manifest/lambda-spec';
export type {
  DeadLetterSpec,
  LambdaSpec,
  ManifestEntry,
} from './manifest/lambda-spec';
export {
  CONNECTION_BUDGET,
  findManifestProblems,
  ManifestError,
  validateManifest,
} from './manifest/validate-manifest';
export {
  functionInfo,
  leaseMsOf,
  manifestEntry,
} from './manifest/function-info';
