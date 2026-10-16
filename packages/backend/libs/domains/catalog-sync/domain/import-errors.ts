import {
  IMPORT_FAILURE_MESSAGES,
  type ImportFailureCode,
} from '@marketplace-sandbox/contracts';

export type { ImportFailureCode };

/**
 * A reason an import cannot go on that has a stable failure code (S07 D-16). Permanent codes end the import at once
 * with no retry; `scan_unavailable` and `internal_error` are the codes recorded when the delivery budget is spent.
 * The message is the fixed text of the code; `detail` (such as missing column names) is generic and safe to show.
 */
export class ImportFailureError extends Error {
  constructor(
    readonly code: ImportFailureCode,
    readonly detail?: string,
    readonly row?: number,
  ) {
    super(IMPORT_FAILURE_MESSAGES[code]);
    this.name = 'ImportFailureError';
  }
}

/** The runner's lease was taken over: it must stop without touching the counters (AS-37). */
export class LeaseLostError extends Error {
  constructor(readonly importId: string) {
    super(`lease of import ${importId} was lost`);
    this.name = 'LeaseLostError';
  }
}

/** Another job of the shop holds the run slot or is earlier in line: hand the message back (AS-60). */
export class ShopBusyError extends Error {
  constructor(readonly importId: string) {
    super(`shop of import ${importId} is running another import`);
    this.name = 'ShopBusyError';
  }
}

/** The runner was told to stop (shutdown): the checkpoint is consistent and the lease released (AS-39). */
export class ImportInterruptedError extends Error {
  constructor() {
    super('import interrupted');
    this.name = 'ImportInterruptedError';
  }
}

/** A conditional transition matched no row: someone else moved the job (AS-58). */
export class StaleTransitionError extends Error {
  constructor(
    readonly importId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`import ${importId} is no longer ${from}`);
    this.name = 'StaleTransitionError';
  }
}
