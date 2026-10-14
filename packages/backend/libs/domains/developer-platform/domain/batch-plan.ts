import { ApiError } from './errors';

export const BATCH_MAX_OPERATIONS = 50;
export const BATCH_BUDGET_MS = 10_000;

export interface BatchOperation {
  method: string;
  path: string;
  body?: unknown;
  ifMatch?: string;
  idempotencyKey?: string;
}

export interface PlannedOperation {
  operation: BatchOperation;
  batchable: boolean;
}

/** Exactly `GET|POST|PATCH /v1/products[/:id]` and `GET /v1/stock/:productId` (AS-43); everything else is refused per operation. */
const BATCHABLE: { method: string; pattern: RegExp }[] = [
  { method: 'GET', pattern: /^\/v1\/products$/ },
  { method: 'POST', pattern: /^\/v1\/products$/ },
  { method: 'GET', pattern: /^\/v1\/products\/[^/]+$/ },
  { method: 'PATCH', pattern: /^\/v1\/products\/[^/]+$/ },
  { method: 'GET', pattern: /^\/v1\/stock\/(?!bulk(\/|$))[^/]+$/ },
];

const isBatchable = (op: BatchOperation): boolean => {
  const path = op.path.split('?')[0];
  return BATCHABLE.some((b) => b.method === op.method && b.pattern.test(path));
};

/** Validates the batch as a whole (1–50 operations) and marks each operation batchable or not (FR-043, FR-044). */
export function planBatch(operations: BatchOperation[]): PlannedOperation[] {
  if (operations.length < 1 || operations.length > BATCH_MAX_OPERATIONS)
    throw new ApiError(
      'validation_failed',
      `A batch holds 1 to ${BATCH_MAX_OPERATIONS} operations.`,
      { errors: [{ field: 'operations', code: 'size' }] },
    );
  return operations.map((operation) => ({
    operation,
    batchable: isBatchable(operation),
  }));
}

/** Rate-limit cost of a batch = its operation count. */
export const batchCost = (operations: readonly unknown[]): number =>
  operations.length;

export const deadlineExceeded = (startedAtMs: number, nowMs: number): boolean =>
  nowMs - startedAtMs >= BATCH_BUDGET_MS;
