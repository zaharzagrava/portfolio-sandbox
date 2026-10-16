import type { OrderExport } from '@marketplace-sandbox/contracts';
import { failureMessage } from '../domain/export-failure';
import type { ExportJobRecord } from '../domain/export-ports';

/**
 * The public shape of an export (contracts/http.md). Never the file key, the shop, the lease or the history; a failure
 * carries its stable code and one fixed generic message.
 */
export function toOrderExport(job: ExportJobRecord): OrderExport {
  return {
    exportId: job.id,
    status: job.status,
    rowsWritten: job.rowsWritten,
    totalRows: job.totalRows,
    bytesWritten: job.bytesWritten,
    attempt: job.attempt,
    failure: job.failureCode
      ? { code: job.failureCode, message: failureMessage(job.failureCode) }
      : null,
    createdBy: job.createdBy,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
  };
}
