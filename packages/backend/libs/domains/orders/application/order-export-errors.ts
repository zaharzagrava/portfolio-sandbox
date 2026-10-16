/**
 * How a failed export run is described to the pure classifier (`domain/export-failure.ts`): every stage of the run tags
 * its failure with an error class, so the rest of the code never inspects a collaborator's message (S12 FR-021).
 */
export class RunError extends Error {
  constructor(
    readonly errorClass: string,
    readonly detail?: unknown,
  ) {
    super(`export run failed: ${errorClass}`);
    this.name = 'RunError';
  }
}

/** The run was told to stop: the export was cancelled, another worker owns it, or this process is shutting down. */
export type StopReason = 'cancelled' | 'lost' | 'shutdown';

export class StopRun extends Error {
  constructor(readonly reason: StopReason) {
    super(`export run stopped: ${reason}`);
    this.name = 'StopRun';
  }
}

interface ErrorLike {
  name?: string;
  message?: string;
  code?: string;
  parent?: { code?: string };
  original?: { code?: string };
}

/** Order store failures: deadlock and serialization are retried, as are timeouts and lost connections. */
export function databaseErrorClass(error: unknown): string {
  const e = (error ?? {}) as ErrorLike;
  const code = e.parent?.code ?? e.original?.code ?? e.code;
  if (code === '40P01') return 'deadlock';
  if (code === '40001') return 'serialization_failure';
  if (code === '57014') return 'order_store_timeout';
  const text = `${e.name ?? ''} ${e.message ?? ''} ${code ?? ''}`;
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return 'order_store_timeout';
  if (/connection|ECONNRESET|ECONNREFUSED|EPIPE/i.test(text))
    return 'connection_reset';
  return 'internal_error';
}

/** Catalog lookup failures: a timeout and any other failure are both retried, under the same code. */
export function catalogErrorClass(error: unknown): string {
  const e = (error ?? {}) as ErrorLike;
  return /timeout|timed out|ETIMEDOUT/i.test(
    `${e.name ?? ''} ${e.message ?? ''}`,
  )
    ? 'catalog_timeout'
    : 'catalog_error';
}
